// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `dark-island.exe --agent-hook codex`: a hook of an AI agent. Runs and
    // exits without starting the island (see agents::hook_main).
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--agent-hook") {
        std::process::exit(dark_island_lib::agent_hook(args.get(2).map(String::as_str).unwrap_or("codex")));
    }
    dark_island_lib::run()
}
