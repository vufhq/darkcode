// The UIMessage model and the reducer that turns an AI SDK UI-message stream
// into it.
//
// Wire format (verified against the `ai` package this repo ships): the response
// is SSE, one `data: {json}` per chunk, terminated by `data: [DONE]`. Chunk
// types are text-start/delta/end, reasoning-*, tool-input-*, tool-output-*,
// start/finish (carrying message metadata) and error.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "json.h"

namespace dc {

enum class PartKind { Text, Reasoning, Tool };

enum class ToolState { InputStreaming, InputAvailable, OutputAvailable, OutputError };

struct ToolCall {
    std::string toolCallId;
    std::string toolName;
    std::string inputTextBuffer; // raw JSON accumulated from tool-input-delta
    json input = json::object();
    json output;
    std::string errorText;
    ToolState state = ToolState::InputStreaming;
    bool dynamic = false; // MCP-style dynamic-tool part
    long long startedMs = 0;
    long long finishedMs = 0;
};

struct Part {
    PartKind kind = PartKind::Text;
    std::string id; // stream-side id, used to route deltas
    std::string text;
    ToolCall tool;
    bool expanded = false; // UI-only
};

struct TurnMetadata {
    std::string model;
    std::string mode;
    long long durationMs = 0;
    long long inputTokens = 0;
    long long outputTokens = 0;
    long long totalTokens = 0;
    bool hasUsage = false;
    long long contextEstimatedTokens = 0;
    long long contextWindow = 0;
    int compactionDropped = 0;
    std::string compactionSummary;
};

struct Message {
    std::string id;
    std::string role; // "user" | "assistant" | "system"
    std::vector<Part> parts;
    TurnMetadata metadata;
    std::string errorText; // stream-level failure, rendered inline
    bool streaming = false;

    json toJson() const;
    static Message fromJson(const json& value);

    std::string plainText() const;
    bool hasPendingToolCalls() const;
};

/// Incremental SSE reader: feed raw bytes, receive complete `data:` payloads.
class SseDecoder {
public:
    void feed(const char* data, size_t length, const std::function<void(const std::string&)>& onEvent);

private:
    std::string buffer_;
};

/// Applies one stream chunk to the assistant message under construction.
void applyChunk(Message& message, const json& chunk);

const char* toolStateWireName(ToolState state);

} // namespace dc
