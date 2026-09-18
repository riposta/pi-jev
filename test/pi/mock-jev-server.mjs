#!/usr/bin/env node
/**
 * Minimal TypeSafe `/v1/systemone` server for testing pi-jev offline.
 *
 * Answers each requested question from the JSON file named by MOCK_JEV_ANSWERS
 * (re-read on every request, so a test can switch scenarios between runs).
 * Questions without an override get a benign default by type.
 *
 * Not a Pi component; only a fixture for the end-to-end test.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.env.MOCK_JEV_PORT ?? 8898);
const answersPath = process.env.MOCK_JEV_ANSWERS;

function loadOverrides() {
  if (!answersPath) return {};
  try {
    return JSON.parse(readFileSync(answersPath, "utf8"));
  } catch (error) {
    console.error(`mock-jev: could not read answers: ${error.message}`);
    return {};
  }
}

function defaultAnswer(id, question) {
  if (question?.type === "noul") return { type: "noul", noul: 0.05 };
  if (question?.type === "score") return { type: "score", score: 0, legend: {}, probabilities: { "0": 1 }, confidence: 0.9 };
  const options = Object.keys(question?.criteria ?? {});
  return { type: "choice", choice: options[0] ?? "other", probabilities: {}, confidence: 0.9 };
}

const server = createServer((req, res) => {
  if (req.url !== "/v1/systemone") {
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
    const overrides = loadOverrides();
    const questions = body.questions ?? {};
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      answers[id] = overrides[id] ?? defaultAnswer(id, question);
    }
    console.error(`mock-jev: model=${body.model} questions=${Object.keys(questions).join(",")}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: body.model ?? "jev-latest",
        answers,
        usage: { input_tokens: 120, output_tokens: 24 },
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-jev listening on http://127.0.0.1:${port}`);
});
