#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible chat-completions server for testing Pi offline.
 *
 * Reads a script (array of steps) from the file in MOCK_SCRIPT:
 *   [ { "text": "..." },
 *     { "tool_calls": [ { "name": "bash", "arguments": { "command": "..." } } ] } ]
 * One step is consumed per request. The last step repeats until the script is
 * exhausted, then a plain stop is returned.
 *
 * Not a Pi component; only a fixture for the end-to-end test.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.env.MOCK_MODEL_PORT ?? 8899);
const scriptPath = process.env.MOCK_SCRIPT;

function loadScript() {
  if (!scriptPath) return [{ text: "Hello from the mock model." }];
  try {
    const parsed = JSON.parse(readFileSync(scriptPath, "utf8"));
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [{ text: "empty script" }];
  } catch (error) {
    console.error(`mock-model: could not read script: ${error.message}`);
    return [{ text: `script error: ${error.message}` }];
  }
}

let stepIndex = 0;

const server = createServer((req, res) => {
  if (!req.url?.endsWith("/chat/completions")) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      /* ignore */
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const script = loadScript();
    // If the script ran out, repeat the last step.
    const step = script[Math.min(stepIndex, script.length - 1)] ?? { text: "done" };
    stepIndex += 1;
    console.error(
      `mock-model: request #${stepIndex} messages=${messages.length} -> ${step.text ? "text" : "tool_calls"}`,
    );

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const send = (delta, finish = null) => {
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-1",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    };

    send({ role: "assistant", content: "" });
    if (step.tool_calls?.length) {
      const toolCalls = step.tool_calls.map((call, index) => ({
        index,
        id: call.id ?? `call_${stepIndex}_${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      }));
      send({ tool_calls: toolCalls });
      send({}, "tool_calls");
    } else {
      for (const piece of String(step.text ?? "").match(/.{1,40}/gs) ?? [""]) {
        send({ content: piece });
      }
      send({}, "stop");
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-model listening on http://127.0.0.1:${port}`);
});
