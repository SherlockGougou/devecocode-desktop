//! DevEco Code Desktop 的库层。
//!
//! 拆成库的目的：主进程（Tauri）与无头自检程序（`deveco-selftest`）共用同一套
//! 逻辑，自检覆盖的代码就是线上真正跑的代码。

pub mod backend;
pub mod cli;
pub mod config;
pub mod events;
pub mod http;
pub mod notify;
pub mod server;
pub mod sse;
