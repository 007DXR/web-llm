import { ExtensionServiceWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

console.log("[Background] Service worker starting...");

// Hookup an engine to a service worker handler
let handler;

// Cache key prefixes
const SUMMARY_CACHE_PREFIX = "page_summary_";
const PENDING_CACHE_PREFIX = "pending_page_";

// Offscreen document state
let offscreenDocumentCreated = false;
let offscreenEngineReady = false;
let isSummarizing = false;
let summarizationQueue: string[] = [];

// Create offscreen document for summarization
async function createOffscreenDocument() {
  if (offscreenDocumentCreated) return;
  
  try {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });
    
    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      console.log("[Background] Offscreen document already exists");
      return;
    }
    
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run WebGPU ML engine for page summarization"
    });
    
    offscreenDocumentCreated = true;
    console.log("[Background] Offscreen document created");
    
  } catch (err) {
    console.error("[Background] Failed to create offscreen document:", err);
  }
}

// Process pending pages queue
async function processSummarizationQueue() {
  if (isSummarizing || summarizationQueue.length === 0 || !offscreenEngineReady) {
    return;
  }
  
  isSummarizing = true;
  
  while (summarizationQueue.length > 0) {
    const url = summarizationQueue.shift()!;
    const pageData = await getPendingPage(url);
    
    if (!pageData) {
      console.log("[Background] Page data not found for:", url);
      continue;
    }
    
    // Check if already summarized
    const existingSummary = await getCachedSummary(url);
    if (existingSummary) {
      console.log("[Background] Summary already exists, skipping:", url);
      await removePendingPage(url);
      continue;
    }
    
    console.log("[Background] Requesting summarization for:", pageData.title);
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SUMMARIZE_PAGE",
        data: {
          url: url,
          title: pageData.title,
          content: pageData.content
        }
      });
      
      if (response.summary) {
        // Save summary
        const cacheKey = SUMMARY_CACHE_PREFIX + url;
        const summaryData = {
          url: url,
          title: pageData.title,
          summary: response.summary,
          timestamp: Date.now(),
          contentLength: pageData.content.length
        };
        
        await chrome.storage.local.set({ [cacheKey]: summaryData });
        await removePendingPage(url);
        console.log("[Background] Summary saved for:", pageData.title);
      } else if (response.error) {
        console.error("[Background] Summarization error:", response.error);
      }
    } catch (err) {
      console.error("[Background] Failed to summarize:", err);
    }
  }
  
  isSummarizing = false;
}

// Get cached summary for a URL
async function getCachedSummary(url: string) {
  const cacheKey = SUMMARY_CACHE_PREFIX + url;
  const cached = await chrome.storage.local.get(cacheKey);
  return cached[cacheKey] || null;
}

// Get pending page content for a URL
async function getPendingPage(url: string) {
  const cacheKey = PENDING_CACHE_PREFIX + url;
  const cached = await chrome.storage.local.get(cacheKey);
  return cached[cacheKey] || null;
}

// Cache page content and trigger summarization
async function cachePendingPage(url: string, title: string, content: string) {
  // First check if we already have a summary
  const existingSummary = await getCachedSummary(url);
  if (existingSummary) {
    console.log("[Background] Summary already exists for:", url);
    return;
  }

  const cacheKey = PENDING_CACHE_PREFIX + url;
  const pageData = {
    url: url,
    title: title,
    content: content,
    timestamp: Date.now()
  };

  await chrome.storage.local.set({ [cacheKey]: pageData });
  console.log("[Background] Page content cached:", title);
  
  // Add to queue and try to process
  if (!summarizationQueue.includes(url)) {
    summarizationQueue.push(url);
  }
  
  // Ensure offscreen document is created and start processing
  await createOffscreenDocument();
  processSummarizationQueue();
}

// Remove pending page after it's been summarized
async function removePendingPage(url: string) {
  const cacheKey = PENDING_CACHE_PREFIX + url;
  await chrome.storage.local.remove(cacheKey);
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === "web_llm_service_worker") {
    if (handler === undefined) {
      handler = new ExtensionServiceWorkerMLCEngineHandler(port);
    } else {
      handler.setPort(port);
    }
    port.onMessage.addListener(handler.onmessage.bind(handler));
  }
});

// Listen for page load messages from content script
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  console.log("[Background] Received message:", message.type, "from tab:", sender.tab?.id);
  
  if (message.type === "PAGE_LOADED") {
    const { url, title, content } = message.data;
    console.log("[Background] PAGE_LOADED received for:", title, "URL:", url, "Content length:", content?.length);
    
    // Cache the page content for later summarization
    cachePendingPage(url, title, content).then(() => {
      sendResponse({ status: "cached", message: "Page content cached for summarization" });
    });
    return true; // Keep channel open for async
    
  } else if (message.type === "GET_CACHED_SUMMARY") {
    const { url } = message.data;
    getCachedSummary(url).then(summary => {
      sendResponse({ summary });
    });
    return true;
    
  } else if (message.type === "GET_ALL_CACHED_SUMMARIES") {
    chrome.storage.local.get(null).then(allData => {
      const summaries: { [key: string]: any } = {};
      for (const key of Object.keys(allData)) {
        if (key.startsWith(SUMMARY_CACHE_PREFIX)) {
          const url = key.replace(SUMMARY_CACHE_PREFIX, "");
          summaries[url] = allData[key];
        }
      }
      console.log("[Background] Returning", Object.keys(summaries).length, "cached summaries");
      sendResponse({ summaries });
    });
    return true;
    
  } else if (message.type === "GET_PENDING_PAGES") {
    chrome.storage.local.get(null).then(allData => {
      const pendingPages: { [key: string]: any } = {};
      for (const key of Object.keys(allData)) {
        if (key.startsWith(PENDING_CACHE_PREFIX)) {
          const url = key.replace(PENDING_CACHE_PREFIX, "");
          pendingPages[url] = allData[key];
        }
      }
      console.log("[Background] Returning", Object.keys(pendingPages).length, "pending pages");
      sendResponse({ pendingPages });
    });
    return true;
    
  } else if (message.type === "SAVE_SUMMARY") {
    const { url, title, summary, contentLength } = message.data;
    const cacheKey = SUMMARY_CACHE_PREFIX + url;
    const summaryData = {
      url: url,
      title: title,
      summary: summary,
      timestamp: Date.now(),
      contentLength: contentLength
    };
    
    chrome.storage.local.set({ [cacheKey]: summaryData }).then(() => {
      // Remove from pending after saving summary
      removePendingPage(url).then(() => {
        console.log("[Background] Summary saved for:", title);
        sendResponse({ status: "saved" });
      });
    });
    return true;
    
  } else if (message.type === "ENGINE_READY") {
    // Offscreen engine is ready
    console.log("[Background] Offscreen engine is ready!");
    offscreenEngineReady = true;
    // Start processing any pending pages
    processSummarizationQueue();
    sendResponse({ status: "acknowledged" });
    return true;
    
  } else if (message.type === "ENGINE_INIT_PROGRESS") {
    console.log("[Background] Engine init progress:", message.data.progress);
    sendResponse({ status: "acknowledged" });
    return true;
    
  } else if (message.type === "ENGINE_ERROR") {
    console.error("[Background] Engine error:", message.data.error);
    sendResponse({ status: "acknowledged" });
    return true;
  }
  
  return true;
});

// Initialize offscreen document on service worker start
createOffscreenDocument();
