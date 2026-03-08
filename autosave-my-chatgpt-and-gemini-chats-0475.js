// ==UserScript==
// @name         Writer's Chat Chronicler v0.47.1 Final Lock
// @namespace    http://tampermonkey.net/
// @version      0.47.1
// @description  Local archiver for long-form creative conversations.
// @match        https://chatgpt.com/*
// @match        https://gemini.google.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ======================================================================
    // CORE UTILS
    // ======================================================================
    const Utils = {
        async hash(string) {
            const encoder = new TextEncoder();
            const data = encoder.encode(string);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        },

        cleanTitle(title) {
            if (!title) return 'Untitled';
            return title
                .replace(/[\\/:*?"<>|]/g, '') // Remove invalid FS chars
                .replace(/\s+/g, '_') // Replace spaces with underscores
                .substring(0, 50) // Truncate long titles
                .replace(/_+$/, ''); // Trim trailing underscores
        },

        formatDate() {
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        },

        normalizeText(element) {
            if (!element) return '';
            
            // Clone to avoid modifying the real DOM
            const clone = element.cloneNode(true);

            // Remove common UI garbage via known classes or roles
            const garbageSelectors = [
                'button', 
                '[role="button"]', 
                'svg', 
                'img', 
                '.copy-button', 
                '.read-aloud', 
                '.regenerate-button', 
                '[aria-label*="Copy"]',
                '[aria-label*="Regenerate"]',
                '[aria-label*="Read aloud"]'
            ];
            
            clone.querySelectorAll(garbageSelectors.join(',')).forEach(el => el.remove());

            // Extract text preserving line breaks and blocks
            let text = '';
            
            const traverse = (node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    text += node.textContent;
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    const tag = node.tagName.toLowerCase();
                    const isBlock = ['p', 'div', 'br', 'li', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].includes(tag);
                    
                    if (tag === 'br') {
                        text += '\n';
                    } else if (isBlock && text.length > 0 && !text.endsWith('\n')) {
                        text += '\n';
                    }

                    if (tag === 'li') {
                        text += '- ';
                    } else if (tag === 'pre' || tag === 'code') {
                        // Preserve formatting inside code blocks better if possible,
                        // but simple traversal works well enough for text extraction.
                    }

                    node.childNodes.forEach(traverse);

                    if (isBlock && !text.endsWith('\n')) {
                        text += '\n';
                    }
                }
            };

            traverse(clone);

            // Collapse excessive newlines
            return text
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        },

        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }
    };

    // ======================================================================
    // INDEXEDDB LAYER
    // ======================================================================
    class DB {
        constructor() {
            this.dbName = 'ChatArchive_v47_1';
            this.version = 1;
            this.db = null;
        }

        async init() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, this.version);

                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('chats')) {
                        db.createObjectStore('chats', { keyPath: 'chatId' });
                    }
                    if (!db.objectStoreNames.contains('messages')) {
                        const msgStore = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                        msgStore.createIndex('chatId', 'chatId', { unique: false });
                        msgStore.createIndex('dedupKey', 'dedupKey', { unique: true });
                        msgStore.createIndex('chatId_archiveOrder', ['chatId', 'archiveOrder'], { unique: false });
                    }
                };

                request.onsuccess = (e) => {
                    this.db = e.target.result;
                    resolve();
                };

                request.onerror = (e) => reject(e.target.error);
            });
        }

        async getChat(chatId) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction('chats', 'readonly');
                const store = tx.objectStore('chats');
                const req = store.get(chatId);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }

        async getHighestVariantIndex(chatId, variantGroupId) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction('messages', 'readonly');
                const store = tx.objectStore('messages');
                const index = store.index('chatId'); // fallback index since we don't have variantGroupId index
                const req = index.getAll(chatId);
                
                req.onsuccess = () => {
                    const messages = req.result;
                    let maxIndex = 0;
                    for (const msg of messages) {
                        if (msg.variantGroupId === variantGroupId && msg.variantIndex > maxIndex) {
                            maxIndex = msg.variantIndex;
                        }
                    }
                    resolve(maxIndex);
                };
                req.onerror = () => reject(req.error);
            });
        }

        async updateChat(chatId, data) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction('chats', 'readwrite');
                const store = tx.objectStore('chats');
                const getReq = store.get(chatId);
                getReq.onsuccess = () => {
                    const existing = getReq.result || { 
                        chatId, 
                        title: 'Untitled', 
                        lastKnownUrl: '', 
                        isArchivingEnabled: false, 
                        stats: { msgCount: 0, lastScan: null, lastExport: null } 
                    };
                    const updated = { 
                        ...existing, 
                        ...data, 
                        stats: { ...existing.stats, ...(data.stats || {}) } 
                    };
                    const putReq = store.put(updated);
                    putReq.onsuccess = () => resolve(updated);
                    putReq.onerror = () => reject(putReq.error);
                };
                getReq.onerror = () => reject(getReq.error);
            });
        }

        async saveMessage(msg) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(['messages', 'chats'], 'readwrite');
                const msgStore = tx.objectStore('messages');
                
                const proceedToPut = (finalMsg) => {
                    const putReq = msgStore.put(finalMsg);
                    putReq.onsuccess = () => {
                        const chatStore = tx.objectStore('chats');
                        const chatReq = chatStore.get(finalMsg.chatId);
                        chatReq.onsuccess = () => {
                            const chat = chatReq.result || { 
                                chatId: finalMsg.chatId, 
                                title: 'Untitled', 
                                lastKnownUrl: '', 
                                isArchivingEnabled: false, 
                                stats: { msgCount: 0, lastScan: null, lastExport: null } 
                            };
                            const countReq = msgStore.index('chatId').count(finalMsg.chatId);
                            countReq.onsuccess = () => {
                                chat.stats.msgCount = countReq.result;
                                chatStore.put(chat);
                            };
                        };
                        resolve(putReq.result);
                    };
                    putReq.onerror = (e) => {
                        if (e.target.error.name === 'ConstraintError') {
                            e.preventDefault();
                            resolve(null); // Deduplicated naturally
                        } else {
                            reject(e.target.error);
                        }
                    };
                };

                if (msg.prevHash !== '__UNKNOWN__') {
                    const unknownDedupKey = `${msg.chatId}:${msg.role}:${msg.textHash}:__UNKNOWN__:${msg.variantIndex}`;
                    const req = msgStore.index('dedupKey').get(unknownDedupKey);
                    req.onsuccess = () => {
                        let finalMsg = msg;
                        if (req.result) {
                            finalMsg = { ...req.result, ...msg, id: req.result.id };
                        }
                        proceedToPut(finalMsg);
                    };
                    req.onerror = () => reject(req.error);
                } else {
                    proceedToPut(msg);
                }
            });
        }

        async getMessages(chatId) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction('messages', 'readonly');
                const index = tx.objectStore('messages').index('chatId_archiveOrder');
                const range = IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]);
                const req = index.getAll(range);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }

        async getMinMaxOrder(chatId) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction('messages', 'readonly');
                const index = tx.objectStore('messages').index('chatId_archiveOrder');
                const range = IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]);
                
                const minReq = index.openCursor(range, 'next');
                const maxReq = index.openCursor(range, 'prev');
                
                let min = null;
                let max = null;
                
                minReq.onsuccess = (e) => {
                    if (e.target.result) min = e.target.result.value.archiveOrder;
                };
                maxReq.onsuccess = (e) => {
                    if (e.target.result) max = e.target.result.value.archiveOrder;
                };
                
                tx.oncomplete = () => resolve({ min, max });
                tx.onerror = () => reject(tx.error);
            });
        }

        async migrateChatId(oldId, newId) {
            if (oldId === newId) return;
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(['messages', 'chats'], 'readwrite');
                const msgStore = tx.objectStore('messages');
                const chatStore = tx.objectStore('chats');


                // Migrate metadata
                const oldChatReq = chatStore.get(oldId);
                oldChatReq.onsuccess = () => {
                    if (oldChatReq.result) {
                        const oldChat = oldChatReq.result;
                        const newChatReq = chatStore.get(newId);
                        newChatReq.onsuccess = () => {
                            if (!newChatReq.result) {
                                oldChat.chatId = newId;
                                chatStore.put(oldChat);
                            }
                            chatStore.delete(oldId);
                        };
                    }
                };

                // Migrate messages
                const index = msgStore.index('chatId');
                const cursorReq = index.openCursor(oldId);
                cursorReq.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        const msg = cursor.value;
                        msg.chatId = newId;
                        msg.dedupKey = `${newId}:${msg.role}:${msg.textHash}:${msg.prevHash}:${msg.variantIndex}`;
                        
                        const updateReq = cursor.update(msg);
                        updateReq.onerror = (err) => {
                            if (err.target.error.name === 'ConstraintError') {
                                err.preventDefault(); // Duplicate exists in new chat, drop the old one
                                cursor.delete();
                            }
                        };
                        cursor.continue();
                    }
                };
                
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            });
        }

        canRead() {
            try {
                if (!this.db) return false;
                this.db.transaction(['messages', 'chats'], 'readonly');
                return true;
            } catch {
                return false;
            }
        }
    }

    const appDb = new DB();

    // ======================================================================
    // CORE ENGINE & STREAMING GUARD
    // ======================================================================
    class Engine {
        constructor(db) {
            this.db = db;
            this.adapter = null;
            this.currentChatId = null;
            this.observer = null;
            this.isArchiving = false;
            this.isScannerActive = false;
            
            // Streaming Guard
            this.pendingEntry = null; 
            this.quietTimeout = null;
            this.lastKnownUserHash = '__ROOT__';
            this.hasConfirmedUserInCurrentPass = false;

            // UI Callbacks
            this.onStateChange = () => {};
            this.onStatsUpdate = () => {};

            // Internal cache for order
            this.currentMaxOrder = 0;
            this.currentMinOrder = Infinity;

            // Strict Variant Hint
            this.pendingVariantHint = null;
        }

        setAdapter(adapterName) {
            let SelectedAdapter = PlatformAdapter;
            
            if (adapterName === 'Auto') {
                if (location.hostname.includes('chatgpt.com')) SelectedAdapter = ChatGPTAdapter;
                else if (location.hostname.includes('gemini.google.com')) SelectedAdapter = GeminiAdapter;
            } else if (adapterName === 'ChatGPT') {
                SelectedAdapter = ChatGPTAdapter;
            } else if (adapterName === 'Gemini') {
                SelectedAdapter = GeminiAdapter;
            }

            this.adapter = new SelectedAdapter();
            return this.adapter.constructor.name;
        }

        async updateCurrentChatId() {
            let id = this.adapter.getChatId();
            
            if (!id) {
                // Determine temp ID
                let firstUserText = null;
                const msgs = this.adapter.extractL1();
                const userMsg = msgs.find(m => m.role === 'USER');
                if (userMsg) firstUserText = userMsg.text;
                
                const rawTempId = this.adapter.getTempId(firstUserText);
                id = await Utils.hash(rawTempId);
            }

            if (this.currentChatId && this.currentChatId !== id) {
                // If old is hash (length 64) and new is NOT hash (stable), migrate!
                if (this.currentChatId.length === 64 && id.length !== 64) {
                    await this.db.migrateChatId(this.currentChatId, id);
                }
            }

            this.currentChatId = id;
            this.lastKnownUserHash = '__ROOT__';
            this.hasConfirmedUserInCurrentPass = false;
            
            // Re-sync order info
            const { min, max } = await this.db.getMinMaxOrder(this.currentChatId);
            this.currentMinOrder = min !== null ? min : Infinity;
            this.currentMaxOrder = max !== null ? max : 0;

            const chat = await this.db.getChat(this.currentChatId);
            const isEnabledForChat = chat ? (chat.isArchivingEnabled ?? false) : false;
            
            this.isArchiving = isEnabledForChat;

            await this.db.updateChat(this.currentChatId, {
                title: document.title,
                lastKnownUrl: location.href,
                isArchivingEnabled: this.isArchiving
            });

            this.updateStats();
            
            if (this.isArchiving) {
                this.startObserverOnly();
            } else {
                this.stopObserverOnly();
            }
        }

        async updateStats() {
            const chat = await this.db.getChat(this.currentChatId);
            if (chat && chat.stats) {
                this.onStatsUpdate(chat.stats.msgCount);
            }
        }

        async setArchiveForCurrentChat(enabled) {
            if (!this.adapter.healthCheck()) {
                this.onStateChange('ADAPTER MISMATCH');
                return;
            }
            this.isArchiving = enabled;
            if (this.currentChatId) {
                await this.db.updateChat(this.currentChatId, { isArchivingEnabled: enabled });
            }
            
            if (enabled) {
                this.startObserverOnly();
            } else {
                this.stopObserverOnly();
            }
        }

        startObserverOnly() {
            if (!this.adapter.healthCheck()) {
                this.onStateChange('ADAPTER MISMATCH');
                return;
            }
            this.onStateChange('ARCHIVING');
            this.setupObserver();
            this.runFullExtraction(); // Initial grab
        }

        stopObserverOnly() {
            this.onStateChange('IDLE');
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
            this.flushPendingEntry('stop');
        }

        setupObserver() {
            if (this.observer) this.observer.disconnect();
            
            const target = this.adapter.getObserverTarget();
            if (!target) return;

            this.observer = new MutationObserver((mutations) => {
                this.handleMutations(mutations);
            });

            this.observer.observe(target, { childList: true, subtree: true, characterData: true });
        }

        async handleMutations(mutations) {
            if (!this.isArchiving || this.isScannerActive) return;

            // L3 Extraction First
            const l3Updates = this.adapter.extractL3FromMutations(mutations);
            if (l3Updates.length > 0) {
                for (const update of l3Updates) {
                    await this.processMessage(update, 'AUTOSAVE');
                }
            } else {
                // Fallback to debounced L1/L2
                this.debouncedFullExtraction();
            }
        }

        debouncedFullExtraction = Utils.debounce(() => {
            this.runFullExtraction();
        }, 1000);

        async runFullExtraction(source = 'AUTOSAVE') {
            if (!this.adapter.healthCheck()) return;

            let msgs = this.adapter.extractL1();
            if (msgs.length === 0) {
                msgs = this.adapter.extractL2();
            }

            // Reset extraction pass context
            this.lastKnownUserHash = '__ROOT__';
            this.hasConfirmedUserInCurrentPass = false;

            for (const msg of msgs) {
                await this.processMessage(msg, source);
            }
        }

        async processMessage(msgData, source, forcedArchiveOrder = null) {
            if (!msgData.text) return;

            const textHash = await Utils.hash(msgData.text);
            
            let prevHash = '__UNKNOWN__';
            if (msgData.role === 'USER') {
                prevHash = this.lastKnownUserHash; // Point back to previous user msg or ROOT
                this.lastKnownUserHash = textHash; // Update tail
                this.hasConfirmedUserInCurrentPass = true;
                
                // Finalize any pending assistant response immediately when user speaks
                await this.flushPendingEntry('user_message');
            } else if (msgData.role === 'ASSISTANT') {
                if (this.hasConfirmedUserInCurrentPass) {
                    prevHash = this.lastKnownUserHash;
                } else {
                    prevHash = '__UNKNOWN__';
                }
            }

            const variantGroupId = prevHash; 
            let variantIndex = 1;

            if (this.adapter.getCapabilities().supportsVariants && variantGroupId !== '__UNKNOWN__') {
                const maxIdx = await this.db.getHighestVariantIndex(this.currentChatId, variantGroupId);
                if (maxIdx > 0) {
                    const messagesForCtx = (await this.db.getMessages(this.currentChatId)).filter(m => m.variantGroupId === variantGroupId);
                    const exactMatch = messagesForCtx.find(m => m.textHash === textHash);
                    
                    if (exactMatch) {
                        variantIndex = exactMatch.variantIndex;
                    } else {
                        // We have different text for the same previous context.
                        // We only branch if we have a strict, confirmed user action hint.
                        if (this.pendingVariantHint) {
                            variantIndex = maxIdx + 1;
                            this.pendingVariantHint = null; // consume hint
                        } else {
                            // Same context, different text, but NO explicit variant hint.
                            // To prevent creating duplicate/competing rows with the same variantIndex, 
                            // we safely skip insertion entirely unless there's a confirmed hint.
                            return { inserted: false, archiveOrder: forcedArchiveOrder ?? this.currentMaxOrder };
                        }
                    }
                }
            }

            const record = {
                chatId: this.currentChatId,
                role: msgData.role,
                text: msgData.text,
                textHash: textHash,
                prevHash: prevHash,
                variantGroupId: variantGroupId,
                variantIndex: variantIndex,
                dedupKey: `${this.currentChatId}:${msgData.role}:${textHash}:${prevHash}:${variantIndex}`,
                captureTimestamp: Date.now(),
                sourceType: source,
                nodeSignature: msgData.nodeSignature,
                archiveOrder: forcedArchiveOrder
            };

            if (msgData.role === 'ASSISTANT' && source !== 'DEEPSCAN') {
                return await this.handleStreamingGuard(record);
            } else {
                return await this.writeToDB(record);
            }
        }

        async handleStreamingGuard(record) {
            // If cap doesn't support streaming guard, just write immediately
            if (!this.adapter.getCapabilities().supportsReliableStreamingDetection) {
                return await this.writeToDB(record);
            }

            if (this.pendingEntry && this.pendingEntry.nodeSignature !== record.nodeSignature) {
                // New assistant node appeared! Flush old one explicitly.
                await this.flushPendingEntry('new_node');
            }

            // Update pending node state in memory but do not write to DB yet.
            // Even if the stream resumes after a pause, we just update the text content.
            this.pendingEntry = record;

            clearTimeout(this.quietTimeout);
            this.quietTimeout = setTimeout(() => {
                // The quiet period is met. This is a finalization signal.
                this.flushPendingEntry('quiet_period');
            }, 1500);
            
            return { inserted: false, archiveOrder: record.archiveOrder };
        }

        async flushPendingEntry(reason) {
            if (this.pendingEntry) {
                // console.log(`[Chronicler] Flushing pending entry. Reason: ${reason}`);
                await this.writeToDB(this.pendingEntry);
                this.pendingEntry = null;
            }
        }

        async writeToDB(record) {
            // Determine archiveOrder
            if (record.archiveOrder === null || record.archiveOrder === undefined) {
                // Not a deep scan forced order, just an append
                this.currentMaxOrder += 100;
                record.archiveOrder = this.currentMaxOrder;
            }

            try {
                const result = await this.db.saveMessage(record);
                if (result) {
                    // It was actually inserted (not deduplicated)
                    await this.db.updateChat(this.currentChatId, { title: document.title });
                    this.updateStats();
                    // Briefly show SAVED indicator
                    this.onStateChange('SAVED');
                    setTimeout(() => { if(this.isArchiving && !this.isScannerActive) this.onStateChange('ARCHIVING'); }, 2000);
                    return { inserted: true, archiveOrder: record.archiveOrder };
                }
                return { inserted: false, archiveOrder: record.archiveOrder };
            } catch (e) {
                this.onStateChange('DB ERROR', "Failed to write message: " + e.message);
                this.stopObserverOnly(); // Abort archiving
                return { inserted: false, archiveOrder: record.archiveOrder };
            }
        }

        async performDeepScan() {
            if (this.pendingEntry) {
                console.warn("Cannot Deep Scan while assistant is streaming.");
                return;
            }
            
            const container = this.adapter.getScrollContainer();
            if (!container) return;

            const originalScroll = container.scrollTop;
            const wasArchiving = this.isArchiving;
            
            this.isScannerActive = true;
            this.isArchiving = false; // Disable normal archive
            this.onStateChange('SCANNING');
            
            if (this.observer) this.observer.disconnect();

            let iterationsWithoutInserts = 0;
            const startTime = Date.now();
            let liveCount = 0;

            try {
                while (true) {
                    if (Date.now() - startTime > 5 * 60 * 1000) break; // 5 min timeout
                    if (container.scrollTop === 0) {
                        await new Promise(r => setTimeout(r, 2000));
                        if (container.scrollTop === 0) break; // Truly at top
                    }

                    container.scrollTop -= 1200;
                    await new Promise(r => setTimeout(r, 1500)); // Wait for render

                    let msgs = this.adapter.extractL1();
                    if (msgs.length === 0) msgs = this.adapter.extractL2();

                    const n = msgs.length;
                    const insertedOrders = [];

                    if (!Number.isFinite(this.currentMinOrder)) {
                        this.lastKnownUserHash = '__ROOT__';
                        this.hasConfirmedUserInCurrentPass = false;

                        for (let i = 0; i < n; i++) {
                            const calculatedOrder = (i + 1) * 100;
                            const result = await this.processMessage(msgs[i], 'DEEPSCAN', calculatedOrder);
                            if (result && result.inserted) insertedOrders.push(result.archiveOrder);
                        }
                        if (insertedOrders.length > 0) {
                            this.currentMinOrder = Math.min(...insertedOrders);
                            this.currentMaxOrder = Math.max(...insertedOrders);
                            iterationsWithoutInserts = 0;
                            liveCount += insertedOrders.length;
                            this.onStateChange(`SCANNING [${liveCount}]`);
                        } else {
                            iterationsWithoutInserts++;
                        }
                    } else {
                        this.lastKnownUserHash = '__ROOT__';
                        this.hasConfirmedUserInCurrentPass = false;

                        let baseOrder = this.currentMinOrder - (n * 100);
                        for (let i = 0; i < n; i++) {
                            const calculatedOrder = baseOrder + (i * 100);
                            const result = await this.processMessage(msgs[i], 'DEEPSCAN', calculatedOrder);
                            if (result && result.inserted) {
                                insertedOrders.push(result.archiveOrder);
                            }
                        }

                        if (insertedOrders.length > 0) {
                            // update global minOrder by actual genuinely prepended minimum
                            this.currentMinOrder = Math.min(this.currentMinOrder, ...insertedOrders);
                            iterationsWithoutInserts = 0;
                            liveCount += insertedOrders.length;
                            this.onStateChange(`SCANNING [${liveCount}]`);
                        } else {
                            iterationsWithoutInserts++;
                        }
                    }

                    if (iterationsWithoutInserts >= 3) break;
                }
            } finally {
                container.scrollTop = originalScroll;
                this.isScannerActive = false;
                this.isArchiving = wasArchiving;
                
                if (wasArchiving) {
                    this.setupObserver();
                    this.onStateChange('ARCHIVING');
                } else {
                    this.onStateChange('IDLE');
                }
                
                this.updateStats();
            }
        }
    }

    // ======================================================================
    // SPA ROUTE WATCHER
    // ======================================================================
    class RouteWatcher {
        constructor(engine) {
            this.engine = engine;
            this.lastUrl = location.href;
            this.checkInterval = null;
        }

        start() {
            // Document level click listener for soft variant hints
            document.body.addEventListener('click', (e) => {
                const text = e.target.innerText || e.target.getAttribute('aria-label') || '';
                const lowerText = text.toLowerCase();
                // Both platforms use 'regenerate', 'edit', 'modify', etc.
                if (lowerText.includes('regenerate') || lowerText.includes('edit') || lowerText.includes('modify')) {
                    this.engine.pendingVariantHint = true;
                    // Reset hint if no new message appears quickly
                    setTimeout(() => { this.engine.pendingVariantHint = null; }, 5000);
                }
            }, true);

            // Overriding history API to catch SPA navigations
            const pushState = history.pushState;
            history.pushState = function() {
                pushState.apply(history, arguments);
                window.dispatchEvent(new Event('pushstate'));
                window.dispatchEvent(new Event('locationchange'));
            };

            const replaceState = history.replaceState;
            history.replaceState = function() {
                replaceState.apply(history, arguments);
                window.dispatchEvent(new Event('replacestate'));
                window.dispatchEvent(new Event('locationchange'));
            };

            window.addEventListener('popstate', () => {
                window.dispatchEvent(new Event('locationchange'));
            });

            window.addEventListener('locationchange', () => this.handleRoute());
            
            // Fallback interval for tricky SPAs that might not fire events perfectly
            this.checkInterval = setInterval(() => {
                if (this.lastUrl !== location.href) {
                    this.handleRoute();
                }
            }, 2000);
            
            // Initial boot
            this.handleRoute();
        }

        async handleRoute() {
            this.lastUrl = location.href;
            
            // Safely flush any pending streams because we're navigating
            await this.engine.flushPendingEntry('route_change');
            
            // updateCurrentChatId now reads DB and automatically starts/stops based on chat preference
            setTimeout(() => {
                this.engine.updateCurrentChatId();
            }, 1000); // Give DOM a second to mount so health check doesn't falsely fail
        }
    }

    // ======================================================================
    // FLOATING UI & STATE MACHINE
    // ======================================================================
    class FloatingUI {
        constructor(engine, performExport) {
            this.engine = engine;
            this.performExport = performExport;
            this.container = null;
            this.state = 'IDLE';
            this.isCollapsed = localStorage.getItem('ChroniclerCollapsed') === 'true';
            this.savedOverride = localStorage.getItem(`ChroniclerEngine_${location.hostname}`) || 'Auto';
        }

        init() {
            this.createPanel();
            this.updateState(this.state);
            this.bindEvents();
            
            this.engine.onStateChange = (state) => this.updateState(state);
            this.engine.onStatsUpdate = (count) => this.updateStats(count);
            
            // Set initial engine
            const actualName = this.engine.setAdapter(this.savedOverride);
            this.updateEngineLabel(this.savedOverride, actualName);
        }

        createPanel() {
            this.container = document.createElement('div');
            this.container.id = 'chronicler-panel';
            Object.assign(this.container.style, {
                position: 'fixed',
                top: '10px',
                right: '10px',
                width: '300px',
                backgroundColor: '#1e1e2e',
                color: '#cdd6f4',
                fontFamily: 'sans-serif',
                fontSize: '13px',
                border: '1px solid #313244',
                borderRadius: '8px',
                zIndex: '99999',
                boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                overflow: 'hidden',
                transition: 'height 0.2s'
            });

            this.container.innerHTML = `
                <div id="chron-header" style="background: #181825; padding: 10px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #313244;">
                    <strong style="color: #f38ba8;">Writer's Chronicler</strong>
                    <span id="chron-collapse" style="font-family: monospace;">${this.isCollapsed ? '[+]' : '[-]'}</span>
                </div>
                <div id="chron-body" style="padding: 10px; display: ${this.isCollapsed ? 'none' : 'block'};">
                    
                    <div style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                        <span>Engine: <span id="chron-engine-label" style="color:#a6e3a1;">Auto</span></span>
                        <select id="chron-engine-select" style="background:#313244; color:#cdd6f4; border:none; border-radius:4px; padding:2px;">
                            <option value="Auto">Auto</option>
                            <option value="ChatGPT">ChatGPT</option>
                            <option value="Gemini">Gemini</option>
                        </select>
                    </div>

                    <div style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                        <span id="chron-status" style="font-weight:bold; color:#89b4fa;">IDLE</span>
                        <label style="display:flex; align-items:center; cursor:pointer;">
                            <input type="checkbox" id="chron-toggle" style="margin-right:5px;"> Enable
                        </label>
                    </div>

                    <div style="margin-bottom: 10px;">
                        <span>Messages in DB: <strong id="chron-count" style="color:#f9e2af;">0</strong></span>
                    </div>

                    <div style="display: flex; gap: 5px;">
                        <button id="chron-deep-scan" style="flex:1; background:#89b4fa; color:#11111b; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">Deep Scan</button>
                        <button id="chron-export" style="flex:1; background:#a6e3a1; color:#11111b; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">Export .txt</button>
                    </div>
                    <div id="chron-error-msg" style="color: #f38ba8; margin-top: 8px; font-size: 11px; display:none;"></div>
                </div>
            `;
            document.body.appendChild(this.container);

            if (this.savedOverride) {
                this.container.querySelector('#chron-engine-select').value = this.savedOverride;
            }
        }

        bindEvents() {
            this.container.querySelector('#chron-header').addEventListener('click', (e) => {
                if (e.target.id === 'chron-engine-select') return;
                this.isCollapsed = !this.isCollapsed;
                localStorage.setItem('ChroniclerCollapsed', this.isCollapsed);
                this.container.querySelector('#chron-body').style.display = this.isCollapsed ? 'none' : 'block';
                this.container.querySelector('#chron-collapse').innerText = this.isCollapsed ? '[+]' : '[-]';
            });

            this.container.querySelector('#chron-engine-select').addEventListener('change', (e) => {
                const val = e.target.value;
                localStorage.setItem(`ChroniclerEngine_${location.hostname}`, val);
                this.engine.flushPendingEntry('adapter_change').then(async () => {
                    const actualName = this.engine.setAdapter(val);
                    this.updateEngineLabel(val, actualName);
                    await this.engine.updateCurrentChatId();
                });
            });

            this.container.querySelector('#chron-toggle').addEventListener('change', (e) => {
                this.engine.setArchiveForCurrentChat(e.target.checked);
            });

            this.container.querySelector('#chron-deep-scan').addEventListener('click', () => {
                if (this.engine.pendingEntry) {
                    this.showError("Wait for assistant to finish before scanning.");
                    return;
                }
                if (!this.engine.adapter.getCapabilities().supportsDeepScan) {
                    this.showError("Deep Scan not supported on this platform.");
                    return;
                }
                this.engine.performDeepScan();
            });

            this.container.querySelector('#chron-export').addEventListener('click', () => {
                this.performExport();
            });
        }

        updateEngineLabel(override, actual) {
            const label = override === 'Auto' ? `Auto (${actual.replace('Adapter', '')})` : override;
            this.container.querySelector('#chron-engine-label').innerText = label;
        }

        updateState(state, errorReason = null) {
            this.state = state;
            const statusEl = this.container.querySelector('#chron-status');
            const toggle = this.container.querySelector('#chron-toggle');
            const scanBtn = this.container.querySelector('#chron-deep-scan');
            const exportBtn = this.container.querySelector('#chron-export');
            const header = this.container.querySelector('#chron-header');
            
            this.hideError();

            statusEl.innerText = state;

            if (state.startsWith('SCANNING')) {
                statusEl.style.color = '#f9e2af';
                toggle.disabled = true;
                scanBtn.disabled = true;
                exportBtn.disabled = true;
            } else if (state === 'ADAPTER MISMATCH') {
                statusEl.style.color = '#fab387';
                toggle.checked = false;
                toggle.disabled = false;
                scanBtn.disabled = true;
                exportBtn.disabled = false; // Still allow export
                this.showError("Health check failed. Autosave blocked.");
            } else if (state === 'DB ERROR') {
                header.style.background = '#721c24';
                statusEl.style.color = '#f38ba8';
                toggle.disabled = true;
                scanBtn.disabled = true;
                exportBtn.disabled = !this.engine.db.canRead();
                if (errorReason) this.showError(errorReason);
            } else if (state === 'ARCHIVING') {
                statusEl.style.color = '#a6e3a1';
                toggle.disabled = false;
                toggle.checked = true;
                scanBtn.disabled = false;
                exportBtn.disabled = false;
            } else if (state === 'SAVED') {
                statusEl.style.color = '#89dceb';
            } else { // IDLE
                statusEl.style.color = '#89b4fa';
                toggle.disabled = false;
                toggle.checked = false;
                scanBtn.disabled = false;
                exportBtn.disabled = false;
            }
        }

        updateStats(count) {
            this.container.querySelector('#chron-count').innerText = count;
        }

        showError(msg) {
            const errEl = this.container.querySelector('#chron-error-msg');
            errEl.innerText = msg;
            errEl.style.display = 'block';
            setTimeout(() => { this.hideError(); }, 4000);
        }

        hideError() {
            this.container.querySelector('#chron-error-msg').style.display = 'none';
        }
    }

    // ======================================================================
    // EXPORT SYSTEM
    // ======================================================================
    async function performExport(engine, ui) {
        if (!engine.currentChatId) {
            ui.showError('No chat ID detected.');
            return;
        }

        const chat = await appDb.getChat(engine.currentChatId);
        const messages = await appDb.getMessages(engine.currentChatId);

        if (messages.length === 0) {
            ui.showError('Archive is empty. Enable archiving or run Deep Scan.');
            return;
        }

        // Sort messages strictly by archiveOrder
        messages.sort((a, b) => a.archiveOrder - b.archiveOrder);

        const safeTitle = Utils.cleanTitle(chat ? chat.title : document.title);
        const shortId = engine.currentChatId.substring(0, 6);
        const dateStr = Utils.formatDate();
        const platform = location.hostname.includes('chatgpt.com') ? 'ChatGPT' : 'Gemini';
        
        const filename = `Archive_${platform}_${safeTitle}_${dateStr}_${shortId}.txt`;

        let content = `======================================================================\n`;
        content += `TITLE: ${chat ? chat.title : document.title}\n`;
        content += `URL: ${chat ? chat.lastKnownUrl : location.href}\n`;
        content += `EXPORT DATE: ${new Date().toLocaleString()}\n`;
        content += `MESSAGE COUNT: ${messages.length}\n`;
        content += `======================================================================\n\n`;

        // Grouping for variants
        const variantMap = {};
        messages.forEach(m => {
            if (!variantMap[m.variantGroupId]) variantMap[m.variantGroupId] = [];
            variantMap[m.variantGroupId].push(m);
        });

        for (const msg of messages) {
            const hasVariants = variantMap[msg.variantGroupId].length > 1;
            const versionStr = hasVariants ? ` | V${msg.variantIndex}` : '';
            
            content += `[${msg.role}]${versionStr}\n`;
            content += `${msg.text}\n\n`;
            content += `----------------------------------------------------------------------\n\n`;
        }

        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ======================================================================
    // BOOTSTRAP
    // ======================================================================
    const bootstrap = async () => {
        const engine = new Engine(appDb);
        // We create the UI first so it can handle DB Init errors properly via its state machine
        const ui = new FloatingUI(engine, () => performExport(engine, ui));
        ui.init();

        try {
            await appDb.init();
            const routeWatcher = new RouteWatcher(engine);
            routeWatcher.start(); // This triggers initial chat ID setup
        } catch (e) {
            console.error("Chronicler DB Error:", e);
            engine.onStateChange('DB ERROR', "IndexedDB Error: " + (e.message || "Init Failed"));
        }
    };

    bootstrap();

    // ======================================================================
    // PLATFORM ADAPTERS
    // ======================================================================

    class PlatformAdapter {
        detect() { return false; }
        getChatId() { return null; }
        getObserverTarget() { return null; }
        getScrollContainer() { return null; }
        extractL1() { return []; }
        extractL2() { return []; }
        extractL3FromMutations(mutations) { return []; }
        cleanText(text) { return text; }
        healthCheck() { return false; }
        getCapabilities() {
            return {
                supportsVariants: false,
                supportsReliableStreamingDetection: false,
                supportsDeepScan: false,
                supportsStableRoleDetection: false
            };
        }
        
        getTempId(firstUserMessage = null) {
            const base = location.hostname + location.pathname;
            if (firstUserMessage) {
                return base + firstUserMessage; // Will be hashed by engine
            }
            return base + document.title;
        }
    }

    class ChatGPTAdapter extends PlatformAdapter {
        detect() {
            return location.hostname.includes('chatgpt.com');
        }

        getChatId() {
            const match = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
            if (match) return match[1];
            return null; // Signals engine to use temp ID
        }

        getObserverTarget() {
            // Target the main message scroll container or its inner layout
            return document.querySelector('main .flex-1.overflow-hidden') || document.querySelector('main');
        }

        getScrollContainer() {
            return document.querySelector('main .flex-1.overflow-hidden .react-scroll-to-bottom--css-jjpys-1n7m0yu') || document.querySelector('main .overflow-y-auto');
        }

        healthCheck() {
            const target = this.getObserverTarget();
            const scroll = this.getScrollContainer();
            const hasL1 = !!document.querySelector('[data-message-author-role]');
            const hasL2 = !!document.querySelector('div.text-base');
            
            const capabilities = this.getCapabilities();
            const scrollOk = capabilities.supportsDeepScan ? !!scroll : true;

            return !!target && scrollOk && (hasL1 || hasL2);
        }

        getCapabilities() {
            return {
                supportsVariants: true,
                supportsReliableStreamingDetection: true,
                supportsDeepScan: true,
                supportsStableRoleDetection: true
            };
        }

        extractL1() {
            const messages = [];
            // Target distinct message blocks
            document.querySelectorAll('[data-message-author-role]').forEach(el => {
                const role = el.getAttribute('data-message-author-role').toUpperCase();
                const id = el.getAttribute('data-message-id') || null;
                const text = this.cleanText(Utils.normalizeText(el));
                
                // ChatGPT variant detection hint: "2/2" text
                // Actually DOM usually has distinct divs, but relying on engine's prevHash mostly.
                // For extraction, just return what's there
                messages.push({
                    node: el,
                    role: role === 'ASSISTANT' ? 'ASSISTANT' : (role === 'USER' ? 'USER' : 'SYSTEM'),
                    text: text,
                    nodeSignature: id || el.className // use ID if available
                });
            });
            return messages;
        }

        extractL2() {
            const messages = [];
            // Fallback: look for generic chat bubbles
            document.querySelectorAll('div.text-base').forEach(el => {
                const text = this.cleanText(Utils.normalizeText(el));
                if (!text) return;
                const isUser = el.textContent.includes('You'); // basic hint
                const role = isUser ? 'USER' : 'ASSISTANT';
                messages.push({
                    node: el,
                    role: role,
                    text: text,
                    nodeSignature: el.className
                });
            });
            return messages;
        }

        extractL3FromMutations(mutations) {
            const updates = [];
            mutations.forEach(m => {
                if (m.type === 'characterData') {
                    const el = m.target.parentElement?.closest('[data-message-author-role]');
                    if (el && el.getAttribute('data-message-author-role') === 'assistant') {
                        updates.push({
                            node: el,
                            role: 'ASSISTANT',
                            text: this.cleanText(Utils.normalizeText(el)),
                            nodeSignature: el.getAttribute('data-message-id') || el.className
                        });
                    }
                } else if (m.type === 'childList') {
                    m.addedNodes.forEach(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = node.closest ? node.closest('[data-message-author-role]') : null;
                            if (el && el.getAttribute('data-message-author-role') === 'assistant') {
                                updates.push({
                                    node: el,
                                    role: 'ASSISTANT',
                                    text: this.cleanText(Utils.normalizeText(el)),
                                    nodeSignature: el.getAttribute('data-message-id') || el.className
                                });
                            }
                        }
                    });
                }
            });
            return updates;
        }
        
        cleanText(text) {
            if (!text) return text;
            // ChatGPT specific artifact cleaning
            return text
                .replace(/^You\n?/g, '') // remove trailing "You" prefix for user
                .replace(/^ChatGPT\n?/g, '') // remove ChatGPT header
                .replace(/\n?Copied!$/g, '') 
                .replace(/\n?Copy code$/g, '')
                .replace(/\n\d+\/\d+\n/g, '\n') // remove "1/2" variant counters
                .trim();
        }
    }

    class GeminiAdapter extends PlatformAdapter {
        detect() {
            return location.hostname.includes('gemini.google.com');
        }

        getChatId() {
            const match = location.pathname.match(/\/app\/([a-zA-Z0-9]+)/);
            if (match) return match[1];
            return null;
        }

        getObserverTarget() {
            return document.querySelector('message-list') || document.querySelector('.conversation-container');
        }

        getScrollContainer() {
            return document.querySelector('.conversation-container') || document.querySelector('message-list');
        }

        healthCheck() {
            const target = this.getObserverTarget();
            const scroll = this.getScrollContainer();
            const hasL1 = !!document.querySelector('user-message, response-message, message-content');
            const hasL2 = !!document.querySelector('.message-content, .model-response-text');
            
            const capabilities = this.getCapabilities();
            const scrollOk = capabilities.supportsDeepScan ? !!scroll : true;

            return !!target && scrollOk && (hasL1 || hasL2);
        }

        getCapabilities() {
            const hasStableSemantics = !!document.querySelector('user-message, response-message');
            return {
                supportsVariants: true,
                supportsReliableStreamingDetection: true,
                supportsDeepScan: true,
                supportsStableRoleDetection: hasStableSemantics 
            };
        }

        extractL1() {
            const messages = [];
            // Target specific Gemini tags
            const nodes = document.querySelectorAll('user-message, response-message, message-content');
            nodes.forEach((el, index) => {
                const text = this.cleanText(Utils.normalizeText(el));
                if (!text) return;
                
                let role = 'RAW';
                if (el.tagName.toLowerCase() === 'user-message') {
                    role = 'USER';
                } else if (el.tagName.toLowerCase() === 'response-message') {
                    role = 'ASSISTANT';
                } else {
                    // Fallback positional
                    role = index % 2 === 0 ? 'USER' : 'ASSISTANT';
                }

                messages.push({
                    node: el,
                    role: role,
                    text: text,
                    nodeSignature: el.id || `gemini-msg-${index}`
                });
            });
            return messages;
        }

        extractL2() {
            const messages = [];
            // Fallback: look for text blocks
            const nodes = document.querySelectorAll('.message-content, .model-response-text');
            nodes.forEach((el, index) => {
                const text = this.cleanText(Utils.normalizeText(el));
                if (!text) return;
                
                const isUser = !el.classList.contains('model-response-text');
                messages.push({
                    node: el,
                    role: isUser ? 'USER' : 'ASSISTANT',
                    text: text,
                    nodeSignature: `gemini-l2-${index}`
                });
            });
            return messages;
        }

        extractL3FromMutations(mutations) {
            const updates = [];
            mutations.forEach(m => {
                if (m.type === 'characterData' || m.type === 'childList') {
                    const target = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : m.target;
                    const el = target.closest('response-message, .model-response-text');
                    if (el) {
                        updates.push({
                            node: el,
                            role: 'ASSISTANT',
                            text: this.cleanText(Utils.normalizeText(el)),
                            nodeSignature: el.id || 'gemini-streaming'
                        });
                    }
                }
            });
            return updates;
        }

        cleanText(text) {
            if (!text) return text;
            return text
                .replace(/Show drafts\n?/g, '')
                .replace(/Good response\n?/g, '')
                .replace(/Bad response\n?/g, '')
                .replace(/Modify response\n?/g, '')
                .replace(/Share and export\n?/g, '')
                .trim();
        }
    }

})();
