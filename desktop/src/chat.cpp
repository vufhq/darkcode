#include "chat.h"

#include "util.h"

namespace dc {
namespace {

ToolState toolStateFromWire(const std::string& value) {
    if (value == "output-available") return ToolState::OutputAvailable;
    if (value == "output-error") return ToolState::OutputError;
    if (value == "input-available") return ToolState::InputAvailable;
    return ToolState::InputStreaming;
}

Part* findPartById(Message& message, PartKind kind, const std::string& id) {
    for (auto it = message.parts.rbegin(); it != message.parts.rend(); ++it) {
        if (it->kind == kind && it->id == id) return &*it;
    }
    return nullptr;
}

Part* findToolPart(Message& message, const std::string& toolCallId) {
    for (auto it = message.parts.rbegin(); it != message.parts.rend(); ++it) {
        if (it->kind == PartKind::Tool && it->tool.toolCallId == toolCallId) return &*it;
    }
    return nullptr;
}

Part& ensureToolPart(Message& message, const json& chunk) {
    const std::string toolCallId = chunk.value("toolCallId", std::string());
    if (Part* existing = findToolPart(message, toolCallId)) return *existing;

    Part part;
    part.kind = PartKind::Tool;
    part.tool.toolCallId = toolCallId;
    part.tool.toolName = chunk.value("toolName", std::string());
    part.tool.dynamic = chunk.value("dynamic", false);
    part.tool.startedMs = nowMs();
    message.parts.push_back(std::move(part));
    return message.parts.back();
}

void mergeMetadata(TurnMetadata& metadata, const json& value) {
    if (!value.is_object()) return;

    if (value.contains("model") && value["model"].is_string()) metadata.model = value["model"].get<std::string>();
    if (value.contains("mode") && value["mode"].is_string()) metadata.mode = value["mode"].get<std::string>();
    if (value.contains("durationMs") && value["durationMs"].is_number()) {
        metadata.durationMs = value["durationMs"].get<long long>();
    }

    if (value.contains("usage") && value["usage"].is_object()) {
        const auto& usage = value["usage"];
        const auto number = [&usage](const char* key) -> long long {
            return usage.contains(key) && usage[key].is_number() ? usage[key].get<long long>() : 0;
        };
        metadata.inputTokens = number("inputTokens");
        metadata.outputTokens = number("outputTokens");
        metadata.totalTokens = number("totalTokens");
        if (metadata.totalTokens == 0) metadata.totalTokens = metadata.inputTokens + metadata.outputTokens;
        metadata.hasUsage = metadata.totalTokens > 0;
    }

    if (value.contains("contextUsage") && value["contextUsage"].is_object()) {
        const auto& context = value["contextUsage"];
        metadata.contextEstimatedTokens = context.value("estimatedTokens", 0LL);
        metadata.contextWindow = context.value("contextWindow", 0LL);
    }

    if (value.contains("compaction") && value["compaction"].is_object()) {
        const auto& compaction = value["compaction"];
        metadata.compactionDropped = compaction.value("droppedCount", 0);
        metadata.compactionSummary = compaction.value("summary", std::string());
    }
}

} // namespace

const char* toolStateWireName(ToolState state) {
    switch (state) {
        case ToolState::OutputAvailable: return "output-available";
        case ToolState::OutputError: return "output-error";
        case ToolState::InputAvailable: return "input-available";
        case ToolState::InputStreaming: return "input-streaming";
    }
    return "input-streaming";
}

json Message::toJson() const {
    json out = json::object();
    out["id"] = id;
    out["role"] = role;

    json partsJson = json::array();
    for (const Part& part : parts) {
        json entry = json::object();
        switch (part.kind) {
            case PartKind::Text:
                if (part.text.empty()) continue;
                entry["type"] = "text";
                entry["text"] = part.text;
                entry["state"] = "done";
                break;
            case PartKind::Reasoning:
                if (part.text.empty()) continue;
                entry["type"] = "reasoning";
                entry["text"] = part.text;
                entry["state"] = "done";
                break;
            case PartKind::Tool: {
                if (part.tool.dynamic) {
                    entry["type"] = "dynamic-tool";
                    entry["toolName"] = part.tool.toolName;
                } else {
                    entry["type"] = "tool-" + part.tool.toolName;
                }
                entry["toolCallId"] = part.tool.toolCallId;
                entry["state"] = toolStateWireName(part.tool.state);
                entry["input"] = part.tool.input;
                if (part.tool.state == ToolState::OutputAvailable) {
                    entry["output"] = part.tool.output.is_null() ? json::object() : part.tool.output;
                } else if (part.tool.state == ToolState::OutputError) {
                    entry["errorText"] = part.tool.errorText;
                }
                break;
            }
        }
        partsJson.push_back(std::move(entry));
    }
    out["parts"] = std::move(partsJson);

    json meta = json::object();
    if (!metadata.mode.empty()) meta["mode"] = metadata.mode;
    if (!metadata.model.empty()) meta["model"] = metadata.model;
    if (!meta.empty()) out["metadata"] = std::move(meta);

    return out;
}

Message Message::fromJson(const json& value) {
    Message message;
    if (!value.is_object()) return message;

    message.id = value.value("id", std::string());
    message.role = value.value("role", std::string("assistant"));

    if (value.contains("metadata")) mergeMetadata(message.metadata, value["metadata"]);

    if (!value.contains("parts") || !value["parts"].is_array()) return message;

    for (const auto& raw : value["parts"]) {
        if (!raw.is_object() || !raw.contains("type") || !raw["type"].is_string()) continue;
        const std::string type = raw["type"].get<std::string>();

        if (type == "text" || type == "reasoning") {
            Part part;
            part.kind = (type == "text") ? PartKind::Text : PartKind::Reasoning;
            part.text = raw.value("text", std::string());
            if (!part.text.empty()) message.parts.push_back(std::move(part));
            continue;
        }

        // "step-start" and any provider-specific part types carry nothing this
        // client renders; dropping them also keeps them out of what we re-send.
        const bool isDynamic = type == "dynamic-tool";
        if (!isDynamic && !startsWith(type, "tool-")) continue;

        Part part;
        part.kind = PartKind::Tool;
        part.tool.dynamic = isDynamic;
        part.tool.toolName = isDynamic ? raw.value("toolName", std::string()) : type.substr(5);
        part.tool.toolCallId = raw.value("toolCallId", std::string());
        part.tool.state = toolStateFromWire(raw.value("state", std::string("input-available")));
        if (raw.contains("input")) part.tool.input = raw["input"];
        if (raw.contains("output")) part.tool.output = raw["output"];
        part.tool.errorText = raw.value("errorText", std::string());
        message.parts.push_back(std::move(part));
    }
    return message;
}

std::string Message::plainText() const {
    std::string out;
    for (const Part& part : parts) {
        if (part.kind != PartKind::Text) continue;
        if (!out.empty()) out += "\n";
        out += part.text;
    }
    return out;
}

bool Message::hasPendingToolCalls() const {
    for (const Part& part : parts) {
        if (part.kind != PartKind::Tool) continue;
        if (part.tool.state != ToolState::OutputAvailable && part.tool.state != ToolState::OutputError) {
            return true;
        }
    }
    return false;
}

void SseDecoder::feed(const char* data, size_t length, const std::function<void(const std::string&)>& onEvent) {
    buffer_.append(data, length);

    size_t start = 0;
    for (;;) {
        const size_t newline = buffer_.find('\n', start);
        if (newline == std::string::npos) break;

        std::string line = buffer_.substr(start, newline - start);
        start = newline + 1;

        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;                 // event separator
        if (!startsWith(line, "data:")) continue;   // id:/event:/retry: lines

        std::string payload = line.substr(5);
        if (!payload.empty() && payload.front() == ' ') payload.erase(0, 1);
        if (payload.empty() || payload == "[DONE]") continue;

        onEvent(payload);
    }
    buffer_.erase(0, start);
}

void applyChunk(Message& message, const json& chunk) {
    if (!chunk.is_object() || !chunk.contains("type") || !chunk["type"].is_string()) return;
    const std::string type = chunk["type"].get<std::string>();

    if (type == "start") {
        // The server reuses the previous assistant id across tool round-trips,
        // and merges incoming messages by id, so adopting it keeps one message.
        const std::string messageId = chunk.value("messageId", std::string());
        if (!messageId.empty()) message.id = messageId;
        if (chunk.contains("messageMetadata")) mergeMetadata(message.metadata, chunk["messageMetadata"]);
        return;
    }
    if (type == "finish" || type == "message-metadata") {
        if (chunk.contains("messageMetadata")) mergeMetadata(message.metadata, chunk["messageMetadata"]);
        return;
    }
    if (type == "start-step" || type == "finish-step") return;

    if (type == "text-start" || type == "reasoning-start") {
        Part part;
        part.kind = (type == "text-start") ? PartKind::Text : PartKind::Reasoning;
        part.id = chunk.value("id", std::string());
        message.parts.push_back(std::move(part));
        return;
    }
    if (type == "text-delta" || type == "reasoning-delta") {
        const PartKind kind = (type == "text-delta") ? PartKind::Text : PartKind::Reasoning;
        const std::string id = chunk.value("id", std::string());
        Part* part = findPartById(message, kind, id);
        if (!part) {
            Part created;
            created.kind = kind;
            created.id = id;
            message.parts.push_back(std::move(created));
            part = &message.parts.back();
        }
        part->text += chunk.value("delta", std::string());
        return;
    }
    if (type == "text-end" || type == "reasoning-end") return;

    if (type == "tool-input-start") {
        ensureToolPart(message, chunk);
        return;
    }
    if (type == "tool-input-delta") {
        Part& part = ensureToolPart(message, chunk);
        part.tool.inputTextBuffer += chunk.value("inputTextDelta", std::string());
        return;
    }
    if (type == "tool-input-available") {
        Part& part = ensureToolPart(message, chunk);
        if (part.tool.toolName.empty()) part.tool.toolName = chunk.value("toolName", std::string());
        if (chunk.contains("input")) part.tool.input = chunk["input"];
        part.tool.state = ToolState::InputAvailable;
        return;
    }
    if (type == "tool-input-error") {
        Part& part = ensureToolPart(message, chunk);
        if (chunk.contains("input")) part.tool.input = chunk["input"];
        part.tool.errorText = chunk.value("errorText", std::string("Tool input was invalid"));
        part.tool.state = ToolState::OutputError;
        part.tool.finishedMs = nowMs();
        return;
    }
    if (type == "tool-output-available") {
        Part& part = ensureToolPart(message, chunk);
        part.tool.output = chunk.contains("output") ? chunk["output"] : json::object();
        part.tool.state = ToolState::OutputAvailable;
        part.tool.finishedMs = nowMs();
        return;
    }
    if (type == "tool-output-error") {
        Part& part = ensureToolPart(message, chunk);
        part.tool.errorText = chunk.value("errorText", std::string("Tool failed"));
        part.tool.state = ToolState::OutputError;
        part.tool.finishedMs = nowMs();
        return;
    }
    if (type == "error") {
        message.errorText = chunk.value("errorText", std::string("The model stream failed"));
        return;
    }
    if (type == "abort") {
        message.errorText = "Turn aborted";
        return;
    }
}

} // namespace dc
