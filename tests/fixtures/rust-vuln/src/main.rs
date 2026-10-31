//! Deliberately vulnerable fixture. Every issue below is reachable from an
//! entry point (an HTTP-style handler or a CLI arg) with attacker-controlled
//! data. Used to sanity-check that a scan rediscovers Phase-1 categories.
use std::process::Command;

/// Entry point: a request handler. `req` is fully attacker-controlled.
pub fn handle_request(req: &Request) -> String {
    let body = lookup(&req.path, &req.query);
    render(body)
}

pub struct Request {
    pub path: String,
    pub query: String,
    pub filename: String,
    pub index: usize,
    pub cmd: String,
    pub user_id: String,
}

// panic-dos: attacker-controlled index into a fixed slice -> panic -> DoS.
fn render(body: Vec<u8>) -> String {
    let table = [b'a', b'b', b'c'];
    let first = table[body[0] as usize]; // double hazard: body[0] and table[...]
    String::from_utf8_lossy(&[first]).to_string()
}

// path-traversal: user filename joined to a base dir with no containment check.
fn lookup(path: &str, _query: &str) -> Vec<u8> {
    let base = std::path::Path::new("/srv/data");
    let full = base.join(path); // `../../etc/passwd` escapes base
    std::fs::read(full).unwrap_or_default()
}

// command-injection: attacker string passed to a shell.
pub fn run_user_command(req: &Request) -> std::io::Result<std::process::Output> {
    Command::new("sh").arg("-c").arg(&req.cmd).output()
}

// sql-injection: user_id concatenated into SQL instead of bound.
pub fn load_user(req: &Request) -> String {
    format!("SELECT * FROM users WHERE id = '{}'", req.user_id)
}

fn main() {
    let req = Request {
        path: std::env::args().nth(1).unwrap_or_default(),
        query: String::new(),
        filename: String::new(),
        index: 0,
        cmd: std::env::args().nth(2).unwrap_or_default(),
        user_id: std::env::args().nth(3).unwrap_or_default(),
    };
    println!("{}", handle_request(&req));
    println!("{}", load_user(&req));
    let _ = run_user_command(&req);
}
