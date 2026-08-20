// Single include point for the vendored nlohmann/json, so the rest of the app
// never spells out the vendor path.
#pragma once

#include <json/json.hpp>

namespace dc {
using json = nlohmann::json;
}
