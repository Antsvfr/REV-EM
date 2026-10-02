---
description: AI and WebLLM engineering rules for REV-EM. Use whenever working on Questions libres, the AI assistant, ai-worker.js, WebLLM, model loading, prompts, conversation memory, streaming, context building, Rapide/Avancé/Expert models, AI performance, WebGPU, or AI error handling.
---

# REV-EM AI Engineering

## Mission

Maintain and improve REV-EM's local AI assistant.

REV-EM uses local WebLLM inference.

Optimize for:

1. answer quality;
2. pedagogical usefulness;
3. reliability;
4. time to first token;
5. context efficiency;
6. GPU stability;
7. maintainability.

The assistant should feel like an integrated educational tutor rather than
a textbox connected to a language model.

## Audit before modification

Before changing AI architecture, inspect:

- ai-worker.js;
- WebLLM initialization;
- engine lifecycle;
- worker lifecycle;
- model configuration;
- Questions libres;
- system prompts;
- user prompts;
- ContextBuilder;
- QuestionAnalyzer;
- PromptBuilder;
- conversation history;
- streaming;
- generation parameters;
- cache;
- error handling;
- Rapide / Avancé / Expert.

Reuse existing components.

Do not create parallel AI pipelines unnecessarily.

## Critical performance rule

Never solve an AI problem by automatically adding more LLM calls.

Prefer deterministic processing for:

- routing;
- intent detection when simple;
- filtering;
- ranking;
- retrieval;
- history selection;
- deduplication;
- simple calculations;
- state management.

Use the LLM primarily for tasks that genuinely require language generation
or reasoning.

## Target pipeline

Prefer a coherent pipeline conceptually similar to:

USER QUESTION
↓
QuestionAnalyzer
↓
Retrieval if needed
↓
Conversation Context
↓
Response Strategy
↓
ContextBuilder
↓
PromptBuilder
↓
WebLLM
↓
Streaming
↓
ANSWER

Adapt this to the actual codebase.

Do not duplicate working components merely to match this diagram.

## Engine lifecycle

Do not unnecessarily:

- recreate the WebLLM engine;
- reload the active model;
- recreate the worker;
- recreate the WebGPU device;
- redownload model files;
- clear model cache.

Prefer:

ENGINE READY
↓
QUESTION
↓
GENERATION
↓
QUESTION
↓
SAME ENGINE

Only one GPU generation should run at a time unless the actual architecture
explicitly proves safe concurrency.

## Context

Context is a limited resource.

Priority should generally be:

1. current question;
2. highly relevant retrieved knowledge;
3. relevant conversation;
4. compact system instructions.

Do not send information merely because it is available.

Avoid sending the entire conversation indefinitely.

Avoid giant static system prompts.

## Conversation memory

Follow-up questions must preserve useful context.

Examples:

"Plus simplement."

"Donne-moi un exemple."

"Et si le taux augmente ?"

These should be interpreted relative to the preceding conversation.

However, old irrelevant exchanges should progressively leave the context.

## Models

Respect the existing or planned:

Rapide
Avancé
Expert

architecture.

Never automatically download a larger model without explicit user action.

The user's selected model remains authoritative.

If a question would benefit from a stronger model, a suggestion may be
shown without automatically switching.

## Knowledge

Keep these sources conceptually distinct:

1. native model knowledge;
2. REV-EM Knowledge;
3. personal course content;
4. future web/current information.

REV-EM Knowledge is not the same as user PDF RAG.

Do not merge their storage architectures.

## Knowledge retrieval

Knowledge retrieval should occur before generation.

Prefer deterministic retrieval when sufficient:

- domain;
- topic;
- aliases;
- keywords;
- scoring.

Do not use an extra LLM call for retrieval by default.

## Reliability

Never fabricate:

- sources;
- URLs;
- papers;
- authors;
- current market prices;
- current events;
- current statistics;
- recent regulations.

A local model without a current external source does not have guaranteed
real-time information.

When current information is required, clearly communicate that limitation
unless a real current-data source exists.

## Calculations

Do not blindly trust generative output for deterministic arithmetic.

Where appropriate, use safe deterministic local calculation and let the
LLM explain the result.

Never use eval(userInput).

## Streaming

Prefer streaming when supported by the real WebLLM implementation.

Optimize especially for Time To First Token.

Where measurable, distinguish:

- preparation time;
- retrieval time;
- generation start;
- TTFT;
- total generation time.

## Errors

Keep technical error states distinct where the architecture supports it.

Examples:

WEBGPU_UNAVAILABLE

MODEL_NOT_READY

ENGINE_INIT_FAILED

DEVICE_LOST

CONTEXT_TOO_LARGE

GENERATION_FAILED

GENERATION_ABORTED

UNKNOWN_ERROR

The user-facing message should remain understandable.

Technical detail belongs in diagnostics.

## GPU stability

A larger model is not automatically better.

Consider:

- WebGPU support;
- memory/resource pressure;
- device loss;
- model compatibility;
- WKWebView differences.

Never invent available VRAM.

Apple Silicon uses unified memory; do not report fictional dedicated VRAM
measurements.

## Compatibility

Consider real differences between:

- Chrome;
- Safari;
- macOS WKWebView;
- mobile browsers;
- WebGPU environments.

A Linux test does not prove WebGPU behavior on the user's Mac.

A mock engine does not prove real WebLLM initialization.

## Multilingual behavior

REV-EM supports:

- French;
- English;
- Spanish;
- German;
- Italian.

Answer naturally in the user's language unless they explicitly request
another language.

New visible UI strings must use the existing translation system.

## Testing

For AI changes, distinguish:

PASS

PASS MOCK

NOT TESTED REAL WEBLLM

NOT TESTED GPU

NOT TESTED MAC

NOT TESTED WKWEBVIEW

Do not claim response-quality improvements based only on compilation.

Use real benchmark questions when evaluating answer quality.

## Regression protection

AI changes must not unnecessarily modify:

- Supabase;
- authentication;
- Storage;
- course import;
- Quiz;
- Flashcards;
- Planning;
- Dashboard;
- macOS widget.

Keep the AI system integrated with the rest of REV-EM without creating
unnecessary coupling.
