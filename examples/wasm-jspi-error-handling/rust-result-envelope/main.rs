#![no_std]
#![no_main]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

// Host imports (provided by Node via WebAssembly.Suspending — see ../test-rust.mjs).
// `fetch` never actually rejects: the host always resolves with a JSON envelope,
// see the RFC for why we deliberately avoid the JSPI reject path.
#[link(wasm_import_module = "env")]
extern "C" {
    fn fetch(ptr: *const u8, len: usize) -> *mut u8;
}

// Bump allocator over a static buffer; matches the host's `alloc(size) -> ptr` contract
// used by executor.ts (unlike the pre-existing rustStarter template, this does not
// return a dangling pointer to a stack-local array).
static mut HEAP: [u8; 65536] = [0; 65536];
static mut BUMP: usize = 0;

#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    unsafe {
        let heap = &raw mut HEAP;
        if BUMP + size > (*heap).len() {
            BUMP = 0;
        }
        let ptr = (*heap).as_mut_ptr().add(BUMP);
        BUMP += size;
        ptr
    }
}

unsafe fn read_cstr<'a>(ptr: *const u8) -> &'a str {
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    core::str::from_utf8_unchecked(core::slice::from_raw_parts(ptr, len))
}

/// Minimal growable-less writer over a fixed buffer (no `alloc` crate available).
struct Writer<'a> {
    buf: &'a mut [u8],
    len: usize,
}

impl<'a> Writer<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        Writer { buf, len: 0 }
    }

    fn push_str(&mut self, s: &str) {
        for b in s.bytes() {
            if self.len < self.buf.len() {
                self.buf[self.len] = b;
                self.len += 1;
            }
        }
    }

    /// Escapes `"` and `\` only — sufficient for the small payloads this demo produces.
    fn push_json_escaped(&mut self, s: &str) {
        for b in s.bytes() {
            if b == b'"' || b == b'\\' {
                self.push_str("\\");
            }
            if self.len < self.buf.len() {
                self.buf[self.len] = b;
                self.len += 1;
            }
        }
    }

    fn finish(self) -> *mut u8 {
        let ptr = alloc(self.len + 1);
        unsafe {
            core::ptr::copy_nonoverlapping(self.buf.as_ptr(), ptr, self.len);
            *ptr.add(self.len) = 0;
        }
        ptr
    }
}

#[derive(Debug, Clone, Copy)]
enum HostaError {
    Fetch,
    Envelope,
}

impl HostaError {
    fn code(self) -> &'static str {
        match self {
            HostaError::Fetch => "FETCH_ERROR",
            HostaError::Envelope => "INVALID_RESULT",
        }
    }

    fn message(self) -> &'static str {
        match self {
            HostaError::Fetch => "upstream fetch reported ok:false",
            HostaError::Envelope => "host returned an unparseable envelope",
        }
    }
}

/// Parses the host's `{"ok":true,"data":"..."}` / `{"ok":false,"error":{...}}` envelope
/// into a `Result`, so business logic below can use `?` like ordinary Rust.
fn hosta_fetch(url: &str) -> Result<&'static str, HostaError> {
    let ptr = unsafe { fetch(url.as_ptr(), url.len()) };
    let raw: &'static str = unsafe { read_cstr(ptr) };
    parse_envelope(raw)
}

fn parse_envelope(raw: &'static str) -> Result<&'static str, HostaError> {
    const PREFIX: &str = "{\"ok\":true,\"data\":\"";
    if let Some(rest) = raw.strip_prefix(PREFIX) {
        match rest.rfind('"') {
            Some(end) => Ok(&rest[..end]),
            None => Err(HostaError::Envelope),
        }
    } else {
        Err(HostaError::Fetch)
    }
}

/// Business logic: idiomatic Rust, no manual envelope handling.
fn handle(_input: &str) -> Result<&'static str, HostaError> {
    let body = hosta_fetch("https://example.com/data")?;
    Ok(body)
}

#[no_mangle]
pub extern "C" fn main() -> i32 {
    let mut out_buf = [0u8; 4096];
    let mut w = Writer::new(&mut out_buf);
    match handle("") {
        Ok(data) => {
            w.push_str("{\"ok\":true,\"data\":\"");
            w.push_json_escaped(data);
            w.push_str("\"}");
        }
        Err(e) => {
            w.push_str("{\"ok\":false,\"error\":{\"code\":\"");
            w.push_str(e.code());
            w.push_str("\",\"message\":\"");
            w.push_json_escaped(e.message());
            w.push_str("\"}}");
        }
    }
    w.finish() as i32
}
