"use strict";

// This code is partially adapted from the openai-chatgpt-chrome-extension repo:
// https://github.com/jessedi0n/openai-chatgpt-chrome-extension

import "./popup.css";

import {
  ChatCompletionMessageParam,
  CreateExtensionServiceWorkerMLCEngine,
  MLCEngineInterface,
  InitProgressReport,
} from "@mlc-ai/web-llm";
import { ProgressBar, Line } from "progressbar.js";

/***************** UI elements *****************/
// Whether or not to use the content from the active tab as the context
const useContext = true;
console.log('useContext value:', useContext);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const queryInput = document.getElementById("query-input")!;
const submitButton = document.getElementById("submit-button")!;

let isLoadingParams = false;
let pageContext = ""; // Store the page context
let allTabContents: { 
  title: string; 
  url: string; 
  content: string; 
  cachedSummary?: string; 
  hasCachedSummary: boolean; 
}[] = []; // Store individual tab contents with cached summary info

// Type for cached summary data
interface CachedSummaryData {
  url: string;
  title: string;
  summary: string;
  timestamp: number;
  contentLength: number;
}

(<HTMLButtonElement>submitButton).disabled = true;

const progressBar: ProgressBar = new Line("#loadingContainer", {
  strokeWidth: 4,
  easing: "easeInOut",
  duration: 1400,
  color: "#ffd166",
  trailColor: "#eee",
  trailWidth: 1,
  svgStyle: { width: "100%", height: "100%" },
});

/***************** Web-LLM MLCEngine Configuration *****************/
const initProgressCallback = (report: InitProgressReport) => {
  progressBar.animate(report.progress, {
    duration: 50,
  });
  if (report.progress == 1.0) {
    enableInputs();
  }
};

const engine: MLCEngineInterface = await CreateExtensionServiceWorkerMLCEngine(
      "Llama-3.2-1B-Instruct-q4f16_1-MLC", 
  // "Llama-3.2-3B-Instruct-q4f32_1-MLC",
  { initProgressCallback: initProgressCallback }
);


isLoadingParams = true;

function enableInputs() {
  if (isLoadingParams) {
    sleep(500);
    (<HTMLButtonElement>submitButton).disabled = false;
    const loadingBarContainer = document.getElementById("loadingContainer")!;
    loadingBarContainer.remove();
    queryInput.focus();
    isLoadingParams = false;
  }
}

/***************** Event Listeners *****************/

// Disable submit button if input field is empty
queryInput.addEventListener("keyup", () => {
  if ((<HTMLInputElement>queryInput).value === "") {
    (<HTMLButtonElement>submitButton).disabled = true;
  } else {
    (<HTMLButtonElement>submitButton).disabled = false;
  }
});

// If user presses enter, click submit button
queryInput.addEventListener("keyup", (event) => {
  if (event.code === "Enter") {
    event.preventDefault();
    submitButton.click();
  }
});

// Listen for clicks on submit button
async function handleClick() {
  // Get the message from the input field
  const message = (<HTMLInputElement>queryInput).value;
  console.log("message", message);

  // Clear the answer
  document.getElementById("answer")!.innerHTML = "";
  // Hide the answer
  document.getElementById("answerWrapper")!.style.display = "none";
  // Show the loading indicator
  document.getElementById("loading-indicator")!.style.display = "block";
  let chatHistory: ChatCompletionMessageParam[] = [];
  let finalMessages: ChatCompletionMessageParam[] = [];

  // Check if we have multiple tabs
  if (allTabContents.length > 1) {
    console.log(`Processing ${allTabContents.length} tabs with smart compression...`);

    // Phase 1: For each tab, use cached summary to determine relevance and extract info
    const compressedTabContents: { title: string; url: string; compressed: string; isRelevant: boolean }[] = [];

    for (let i = 0; i < allTabContents.length; i++) {
      const tabInfo = allTabContents[i];
      console.log(`Processing tab ${i + 1}/${allTabContents.length}: ${tabInfo.title} (has cached summary: ${tabInfo.hasCachedSummary})`);

      let compressedContent = "";
      let isRelevant = false;

      if (tabInfo.hasCachedSummary && tabInfo.cachedSummary) {
        // Step 1: Use cached summary to check relevance
        console.log(`Checking relevance using cached summary for: ${tabInfo.title}`);
        
        const relevanceMessages: ChatCompletionMessageParam[] = [
          {
            role: "system",
            content: "Classify page relevance. Always output ALL three lines in this exact format:\nRELEVANT: yes\nSUFFICIENT: yes\nEXTRACTED: key facts here\n\nOr if not relevant:\nRELEVANT: no\nSUFFICIENT: no\nEXTRACTED: N/A"
          },
          {
            role: "user",
            content: `Summary: ${tabInfo.cachedSummary}\n\nQuestion: ${message}\n\nOutput all three lines:`
          }
        ];

        let relevanceResponse = "";
        const relevanceCompletion = await engine.chat.completions.create({
          stream: true,
          messages: relevanceMessages,
        });

        for await (const chunk of relevanceCompletion) {
          const curDelta = chunk.choices[0].delta.content;
          if (curDelta) {
            relevanceResponse += curDelta;
          }
        }

        console.log(`Relevance check result for ${tabInfo.title}:`, relevanceResponse);

        // Parse the relevance response
        const isPageRelevant = relevanceResponse.toLowerCase().includes("relevant: yes");
        const isSufficient = relevanceResponse.toLowerCase().includes("sufficient: yes");
        isRelevant = isPageRelevant;

        if (isPageRelevant) {
          if (isSufficient) {
            // Extract from the relevance response (after "EXTRACTED:")
            const extractedMatch = relevanceResponse.match(/EXTRACTED:\s*([\s\S]*)/i);
            compressedContent = extractedMatch ? extractedMatch[1].trim() : tabInfo.cachedSummary;
            console.log(`Summary sufficient for ${tabInfo.title}, using extracted info`);
          } else {
            // Summary not sufficient, need to extract from original content
            console.log(`Summary not sufficient for ${tabInfo.title}, extracting from original content`);
            
            const extractionMessages: ChatCompletionMessageParam[] = [
              {
                role: "system",
                content: "Extract facts from the provided content that answer the question. Format: Concise bullet points. If missing, say 'No relevant information'. No conversational filler."
              },
              {
                role: "user",
                content: `CONTEXT: ${tabInfo.content}\nQUESTION: ${message}\nRESULT:`
              }
            ];

            const extractionCompletion = await engine.chat.completions.create({
              stream: true,
              messages: extractionMessages,
            });

            for await (const chunk of extractionCompletion) {
              const curDelta = chunk.choices[0].delta.content;
              if (curDelta) {
                compressedContent += curDelta;
              }
            }
          }
        } else {
          compressedContent = "No relevant information for this question.";
        }
      } else {
        // No cached summary - fallback to original compression logic
        console.log(`No cached summary for ${tabInfo.title}, using full content extraction`);
        isRelevant = true; // Assume relevant when no summary available

        const compressionMessages: ChatCompletionMessageParam[] = [
          {
            role: "system",
            content: "Extract facts from the provided content that answer the question. Format: Concise bullet points. If missing, say 'No relevant information'. No conversational filler."
          },
          {
            role: "user",
            content: `CONTEXT: ${tabInfo.content}\nQUESTION: ${message}\nRESULT:`
          }
        ];

        const compressionCompletion = await engine.chat.completions.create({
          stream: true,
          messages: compressionMessages,
        });

        for await (const chunk of compressionCompletion) {
          const curDelta = chunk.choices[0].delta.content;
          if (curDelta) {
            compressedContent += curDelta;
          }
        }
      }

      compressedTabContents.push({
        title: tabInfo.title,
        url: tabInfo.url,
        compressed: compressedContent,
        isRelevant: isRelevant
      });

      console.log(`Tab ${i + 1} processed: relevant=${isRelevant}, compressed length=${compressedContent.length}`);
    }

    // Phase 2: Filter to only relevant tabs and combine compressed contents
    const relevantTabs = compressedTabContents.filter(tab => tab.isRelevant);
    console.log(`Found ${relevantTabs.length} relevant tabs out of ${compressedTabContents.length}`);

    const combinedCompressedContext = relevantTabs.length > 0
      ? relevantTabs
          .map((tabInfo, index) =>
            `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\nRelevant Information: ${tabInfo.compressed}\n`
          )
          .join("\n")
      : compressedTabContents
          .map((tabInfo, index) =>
            `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\nRelevant Information: ${tabInfo.compressed}\n`
          )
          .join("\n");

    console.log("All tabs processed, generating final answer...");

    // Create final message history with compressed context
    finalMessages = [
      {
        role: "system",
        content: `You are a helpful assistant. The user has ${allTabContents.length} browser tabs open. Below is the relevant information extracted from ${relevantTabs.length > 0 ? relevantTabs.length + ' relevant' : 'all'} tabs based on the user's question:\n\n${combinedCompressedContext}\n\nPlease provide a comprehensive answer to the user's question based on this information.`
      },
      {
        role: "user",
        content: message
      }
    ];
  } else {
    // Single tab or no tabs: use original logic
    console.log("Single tab or no tabs, using original logic...");
    // Combine all tab contents into a single context (for single-tab fallback)
    pageContext = allTabContents
      .map((tabInfo, index) =>
        // `[${tabInfo.title}](${tabInfo.url}):${tabInfo.content}\n`
        `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\n\n${tabInfo.content}\n\n`
      )
      .join("\n");
    // For single tab, use original logic
    chatHistory.push({
      role: "system",
      content: `You are a helpful assistant. Here is the content of the browser tab:\n\n${pageContext}\n\nPlease answer questions about this webpage based on the content provided above.`
    });
    console.log("Single tab content loaded:", pageContext.substring(0, 200) + "...");
    chatHistory.push({ role: "user", content: message });
    finalMessages = chatHistory;
  }

  console.log("Final messages:", finalMessages);

  // Send the final chat completion message to the engine
  let curMessage = "";
  const completion = await engine.chat.completions.create({
    stream: true,
    messages: finalMessages,
  });

  // Update the answer as the model generates more text
  for await (const chunk of completion) {
    const curDelta = chunk.choices[0].delta.content;
    if (curDelta) {
      curMessage += curDelta;
    }
    updateAnswer(curMessage);
  }

  // Update chat history
  chatHistory.push({ role: "assistant", content: await engine.getMessage() });
 
}

submitButton.addEventListener("click", handleClick);

function updateAnswer(answer: string) {
  // Show answer
  document.getElementById("answerWrapper")!.style.display = "block";
  const answerWithBreaks = answer.replace(/\n/g, "<br>");
  document.getElementById("answer")!.innerHTML = answerWithBreaks;
  // Add event listener to copy button
  document.getElementById("copyAnswer")!.addEventListener("click", () => {
    // Get the answer text
    const answerText = answer;
    // Copy the answer text to the clipboard
    navigator.clipboard
      .writeText(answerText)
      .then(() => console.log("Answer text copied to clipboard"))
      .catch((err) => console.error("Could not copy text: ", err));
  });
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  };
  const time = new Date().toLocaleString("en-US", options);
  // Update timestamp
  document.getElementById("timestamp")!.innerText = time;
  // Hide loading indicator
  document.getElementById("loading-indicator")!.style.display = "none";
}

// Helper function to get cached summary for a URL
async function getCachedSummary(url: string): Promise<CachedSummaryData | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_CACHED_SUMMARY", data: { url } },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("Error getting cached summary:", chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(response?.summary || null);
        }
      }
    );
  });
}

function fetchPageContents() {
  // Query all tabs in the current window instead of just the active one
  chrome.tabs.query({ currentWindow: true }, async function (tabs) {
    if (tabs.length === 0) {
      console.warn("⚠️ No tabs found in current window");
      return;
    }

    // First, get all cached summaries
    const cachedSummariesPromise = new Promise<{ [url: string]: CachedSummaryData }>((resolve) => {
      chrome.runtime.sendMessage(
        { type: "GET_ALL_CACHED_SUMMARIES" },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn("Error getting all cached summaries:", chrome.runtime.lastError);
            resolve({});
          } else {
            resolve(response?.summaries || {});
          }
        }
      );
    });

    const cachedSummaries = await cachedSummariesPromise;
    console.log(`Found ${Object.keys(cachedSummaries).length} cached summaries`);

    tabs.forEach((tab) => {
      if (tab.id) {
        try {
          const port = chrome.tabs.connect(tab.id, { name: "channelName" });
          port.postMessage({});
          port.onMessage.addListener(function (msg) {
            const tabUrl = tab.url || "Unknown URL";
            const cachedSummary = cachedSummaries[tabUrl];
            
            // Store each tab's content with metadata and cached summary in the global array
            allTabContents.push({
              title: tab.title || "Untitled",
              url: tabUrl,
              content: msg.contents,
              cachedSummary: cachedSummary?.summary,
              hasCachedSummary: !!cachedSummary
            });

            console.log(`Tab loaded: ${tab.title}, has cached summary: ${!!cachedSummary}`);
          });
          port.onDisconnect.addListener(() => {
            if (chrome.runtime.lastError) {
              // Suppress the error and show a warning instead
              console.warn(`⚠️ Could not connect to tab ${tab.id} (${tab.title || 'Untitled'}): ${chrome.runtime.lastError.message}. This may happen if the extension was recently reloaded - please refresh the page to enable content extraction.`);
            }
          });
        } catch (error) {
          console.warn(`⚠️ Failed to connect to tab ${tab.id} (${tab.title || 'Untitled'}): ${error instanceof Error ? error.message : String(error)}. This may happen if the extension was recently reloaded - please refresh the page.`);
        }
      }
    });
  });
  
}


// Grab the page contents when the popup is opened
// Use DOMContentLoaded instead of window.onload to ensure it fires
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    if (useContext) {
      fetchPageContents();
    }
  });
} else {
  // Document already loaded
  if (useContext) {
    fetchPageContents();
  }
}