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
let allTabContents: { title: string; url: string; content: string }[] = []; // Store individual tab contents

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
  "Llama-3.2-3B-Instruct-q4f32_1-MLC",
  { initProgressCallback: initProgressCallback }
);
const chatHistory: ChatCompletionMessageParam[] = [];

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
  fetchPageContents()
  // Get the message from the input field
  const message = (<HTMLInputElement>queryInput).value;
  console.log("message", message);

  // Clear the answer
  document.getElementById("answer")!.innerHTML = "";
  // Hide the answer
  document.getElementById("answerWrapper")!.style.display = "none";
  // Show the loading indicator
  document.getElementById("loading-indicator")!.style.display = "block";

  let finalMessages: ChatCompletionMessageParam[] = [];

  // Check if we have multiple tabs
  if (allTabContents.length > 1) {
    console.log(`Processing ${allTabContents.length} tabs with compression...`);

    // Phase 1: Compress each tab's content individually
    const compressedTabContents: { title: string; url: string; compressed: string }[] = [];

    for (let i = 0; i < allTabContents.length; i++) {
      const tabInfo = allTabContents[i];
      console.log(`Compressing tab ${i + 1}/${allTabContents.length}: ${tabInfo.title}`);

      // Create a temporary message history for compression
      const compressionMessages: ChatCompletionMessageParam[] = [
        {
          role: "system",
          content: `You are an information extraction expert.  Your task is to read the provided web page content and extract ONLY the information that is relevant to the user's question. If no relevant information, say "no relevant information"`
        },
        {
          role: "user",
          content: `QUESTION: "${message}"
SOURCE: [${tabInfo.title}](${tabInfo.url})
CONTENT: 
${tabInfo.content}
Extracted relevant info:`}
      ];

      // Get compressed content from the engine
      let compressedContent = "";
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

      compressedTabContents.push({
        title: tabInfo.title,
        url: tabInfo.url,
        compressed: compressedContent
      });

      console.log(`Tab ${i + 1} compressed: ${compressedContent.length} characters；compressedContent:${compressedContent}`);
    }

    // Phase 2: Combine all compressed contents and generate final answer
    const combinedCompressedContext = compressedTabContents
      .map((tabInfo, index) =>
        `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\nRelevant Information: ${tabInfo.compressed}\n`
      )
      .join("\n");

    console.log("All tabs compressed, generating final answer...");

    // Create final message history with compressed context
    finalMessages = [
      {
        role: "system",
        content: `You are a helpful assistant. The user has ${allTabContents.length} browser tabs open. Below is the relevant information extracted from each tab based on the user's question:\n\n${combinedCompressedContext}\n\nPlease provide a comprehensive answer to the user's question based on this information.`
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
  if (allTabContents.length > 1) {
    // For multi-tab scenario, store the compressed conversation
    chatHistory.push({ role: "assistant", content: await engine.getMessage() });
  } else {

    chatHistory.push({ role: "assistant", content: await engine.getMessage() });
  }
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

function fetchPageContents() {
  // Query all tabs in the current window instead of just the active one
  chrome.tabs.query({ currentWindow: true }, function (tabs) {
    // let completedTabs = 0;

    if (tabs.length === 0) {
      console.warn("⚠️ No tabs found in current window");
      return;
    }

    tabs.forEach((tab) => {
      if (tab.id) {
        try {
          const port = chrome.tabs.connect(tab.id, { name: "channelName" });
          port.postMessage({});
          port.onMessage.addListener(function (msg) {
            // Store each tab's content with metadata in the global array
            allTabContents.push({
              title: tab.title || "Untitled",
              url: tab.url || "Unknown URL",
              content: msg.contents
            });


          });

          // // Handle connection errors (e.g., for chrome:// pages, pages without content script, or stale content scripts after extension reload)
          // port.onDisconnect.addListener(() => {
          //   if (chrome.runtime.lastError) {
          //     // Suppress the error and show a warning instead
          //     console.warn(`⚠️ Could not connect to tab ${tab.id} (${tab.title || 'Untitled'}): ${chrome.runtime.lastError.message}. This may happen if the extension was recently reloaded - please refresh the page to enable content extraction.`);
          //   }
          //   completedTabs++;
          //   if (completedTabs === tabs.length) {
          //     if (allTabContents.length === 0) {
          //       console.warn("⚠️ No tab content was retrieved. If you recently reloaded the extension, please refresh your browser tabs to enable content extraction.");
          //     } else if (chatHistory.length === 0 && pageContext && allTabContents.length === 1) {
          //       chatHistory.push({
          //         role: "system",
          //         content: `You are a helpful assistant. Here is the content of the accessible browser tab:\n\n${pageContext}\n\nPlease answer questions about this webpage based on the content provided above.`
          //       });
          //     }
          //   }
          // });
        } catch (error) {
          console.warn(`⚠️ Failed to connect to tab ${tab.id} (${tab.title || 'Untitled'}): ${error instanceof Error ? error.message : String(error)}. This may happen if the extension was recently reloaded - please refresh the page.`);
          // completedTabs++;
        }
      } else {
        // completedTabs++;
      }
    });
  });
}

// Grab the page contents when the popup is opened
// Use DOMContentLoaded instead of window.onload to ensure it fires
// if (document.readyState === 'loading') {
//   document.addEventListener('DOMContentLoaded', function() {
//     if (useContext) {
//       fetchPageContents();
//     }
//   });
// } else {
//   // Document already loaded
//   if (useContext) {
//     fetchPageContents();
//   }
// }
