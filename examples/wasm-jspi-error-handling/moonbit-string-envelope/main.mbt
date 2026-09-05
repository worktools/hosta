// Verifies that MoonBit's `wasm-gc` backend + JS String Builtins lets host
// imports/exports exchange plain `String` values across the JSPI boundary,
// with no manual linear-memory pointer marshaling (unlike the classic `wasm`
// backend used for Rust — see ../rust-result-envelope for that path, and
// ../../../RFCs for why the two backends need different bridges).

///|
/// Host import: resolves to a JSON envelope string, wrapped in
/// `WebAssembly.Suspending` on the JS side. Never actually rejects — see RFC.
fn host_fetch(url : String) -> String = "env" "fetch"

///|
/// Parses `{"ok":true,"data":"..."}` / `{"ok":false,"error":{...}}` into a
/// `Result`, mirroring the Rust demo's `hosta_fetch` helper. Errors carry a
/// (code, message) pair so callers don't have to re-parse a stringified blob.
fn hosta_fetch(url : String) -> Result[String, (String, String)] {
  let raw = host_fetch(url)
  let parsed = Some(@json.parse(raw)) catch { _ => None }
  match parsed {
    None => Err(("INVALID_RESULT", "host response is not JSON"))
    Some(json) =>
      if json is Object(obj) {
        match obj.get("ok") {
          Some(Json::True) =>
            match obj.get("data") {
              Some(Json::String(s)) => Ok(s)
              _ => Err(("INVALID_RESULT", "missing \"data\" string"))
            }
          _ =>
            match obj.get("error") {
              Some(Json::Object(errObj)) => {
                let code = match errObj.get("code") {
                  Some(Json::String(c)) => c
                  _ => "UNKNOWN_ERROR"
                }
                let message = match errObj.get("message") {
                  Some(Json::String(m)) => m
                  _ => "no message"
                }
                Err((code, message))
              }
              _ => Err(("INVALID_RESULT", "missing \"error\" object"))
            }
        }
      } else {
        Err(("INVALID_RESULT", "envelope is not a JSON object"))
      }
  }
}

///|
/// Business logic: idiomatic MoonBit, no manual envelope handling.
fn handle() -> Result[String, (String, String)] {
  hosta_fetch("https://example.com/data")
}

///|
/// Exported (renamed to "main" via moon.pkg `exports: ["run:main"]`) and
/// wrapped with `WebAssembly.promising` on the JS side.
pub fn run() -> String {
  match handle() {
    Ok(data) => {
      let obj : Map[String, Json] = {
        "ok": Json::boolean(true),
        "data": Json::string(data),
      }
      Json::object(obj).stringify()
    }
    Err((code, message)) => {
      let err : Map[String, Json] = {
        "code": Json::string(code),
        "message": Json::string(message),
      }
      let obj : Map[String, Json] = {
        "ok": Json::boolean(false),
        "error": Json::object(err),
      }
      Json::object(obj).stringify()
    }
  }
}
