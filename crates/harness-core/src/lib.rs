//! Shared types for the @agent-sh/harness-* Rust tools.
//!
//! Mirrors the TypeScript `@agent-sh/harness-core` package so tool ports
//! can conform to the same cross-language design spec. The public API
//! here is the Rust-side contract: [`ToolError`] + [`ToolErrorCode`] for
//! structured failures, [`PermissionPolicy`] for the fence shape,
//! [`PermissionDecision`] for hook outcomes, and the [`format_tool_error`]
//! helper that produces the canonical `Error [CODE]: message` string
//! every tool wraps errors in at the executor boundary.

pub mod errors;
pub mod permissions;

pub use errors::{format_tool_error, ToolError, ToolErrorCode};
pub use permissions::{PermissionDecision, PermissionHook, PermissionPolicy};
