"use strict";

import { CreateMLCEngine, MLCEngineInterface, ChatCompletionMessageParam } from "@mlc-ai/web-llm";

console.log("[Offscreen] Offscreen document loaded");

let engine: MLCEngineInterface | null = null;
let isEngineInitializing = false;
let engineReady = false;

// Initialize the engine
async function initEngine() {
  if (engine || isEngineInitializing) return;
  
  isEngineInitializing = true;
  console.log("[Offscreen] Initializing engine...");
  
  try {
    engine = await CreateMLCEngine(
      "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      {
        initProgressCallback: (report) => {
          console.log("[Offscreen] Engine init progress:", Math.round(report.progress * 100) + "%");
          // Notify background about progress
          chrome.runtime.sendMessage({
            type: "ENGINE_INIT_PROGRESS",
            data: { progress: report.progress }
          });
        }
      }
    );
    engineReady = true;
    console.log("[Offscreen] Engine initialized successfully!");
    
    // Notify background that engine is ready
    chrome.runtime.sendMessage({
      type: "ENGINE_READY"
    });
    
  } catch (err) {
    console.error("[Offscreen] Failed to initialize engine:", err);
    chrome.runtime.sendMessage({
      type: "ENGINE_ERROR",
      data: { error: String(err) }
    });
  } finally {
    isEngineInitializing = false;
  }
}

// Summarize a page
async function summarizePage(url: string, title: string, content: string): Promise<string> {
  if (!engine || !engineReady) {
    throw new Error("Engine not ready");
  }

  console.log("[Offscreen] Summarizing page:", title);

  // Truncate content if too long
  const maxContentLength = 8000;
  const truncatedContent = content.length > maxContentLength 
    ? content.substring(0, maxContentLength) + "..." 
    : content;

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "You are a helpful assistant that summarizes web pages. Create a concise summary with key points (5-10 bullet points). Focus on: main topics, key facts, important details, and actionable information. Be brief but comprehensive."
    },
    {
      role: "user",
      content: `Summarize this webpage:\n\nTitle: ${title}\n\nContent:\n${truncatedContent}`
    }
  ];

  let summary = "";
  const completion = await engine.chat.completions.create({
    stream: true,
    messages: messages,
  });

  for await (const chunk of completion) {
    const delta = chunk.choices[0].delta.content;
    if (delta) {
      summary += delta;
    }
  }

  console.log("[Offscreen] Summary generated:", summary.length, "chars");
  console.log("[Offscreen] Summary content:\n", summary);
  return summary;
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Offscreen] Received message:", message.type);

  if (message.type === "INIT_ENGINE") {
    initEngine().then(() => {
      sendResponse({ status: "initializing" });
    });
    return true;

  } else if (message.type === "SUMMARIZE_PAGE") {
    const { url, title, content } = message.data;
    
    if (!engineReady) {
      sendResponse({ error: "Engine not ready" });
      return true;
    }

    summarizePage(url, title, content)
      .then((summary) => {
        sendResponse({ summary });
      })
      .catch((err) => {
        console.error("[Offscreen] Summarization error:", err);
        sendResponse({ error: String(err) });
      });
    
    return true; // Keep channel open for async response

  } else if (message.type === "CHECK_ENGINE_STATUS") {
    sendResponse({ 
      ready: engineReady, 
      initializing: isEngineInitializing 
    });
    return true;
  }

  return false;
});

// Auto-initialize engine when offscreen document loads
initEngine();
