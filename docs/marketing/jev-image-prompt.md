# Prompt do wygenerowania grafiki promocyjnej (Gemini / Imagen)

Format sugerowany: 16:9 (baner pod LinkedIn), bez tekstu na obrazku.

## Prompt

```
A sleek, modern editorial illustration for a tech article about AI decision-making.
On the left side, a chaotic glowing cloud of text and words representing a large
language model generating unstructured prose. On the right side, that same energy
resolved into clean geometric shapes: checkmarks, probability gauges, and branching
decision nodes, representing fast structured AI decisions. A clear visual
transformation from chaos into structure, connected by a glowing conduit or beam of
light running left to right. Dark navy background, cyan and violet neon accents,
high-tech minimalist style, no text, no words, no letters, no numbers anywhere in
the image, wide banner composition, professional LinkedIn cover art, high detail,
cinematic lighting.
```

## Parametry (jeśli wywołujesz przez API, np. `imagen-4.0-generate-001` / `imagen-3.0-generate-002`)

```json
{
  "instances": [{ "prompt": "<prompt powyżej>" }],
  "parameters": {
    "sampleCount": 2,
    "aspectRatio": "16:9",
    "safetySetting": "block_only_high",
    "personGeneration": "dont_allow"
  }
}
```

## Wariant krótszy (np. do UI Gemini/AI Studio)

```
Editorial tech illustration, split composition: left side chaotic glowing cloud of
text (unstructured LLM output), right side clean geometric decision shapes —
checkmarks, gauges, branching nodes (structured AI decisions). Dark navy background,
cyan/violet neon accents, minimalist high-tech style, no text or letters, wide 16:9
banner, professional LinkedIn cover art.
```
