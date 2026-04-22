use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use crate::types::WebFetchSessionConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockClass {
    Loopback,
    Private,
    LinkLocal,
    Metadata,
    Reserved,
}

impl BlockClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Loopback => "loopback",
            Self::Private => "private",
            Self::LinkLocal => "link-local",
            Self::Metadata => "metadata",
            Self::Reserved => "reserved",
        }
    }
}

#[derive(Debug, Clone)]
pub enum SsrfDecision {
    Allowed,
    Blocked { reason: String, hint: String },
}

/// Resolve the host and run the IP classifier against each result.
/// Returns `Blocked` if any resolved IP lands in a range not opted into.
pub async fn classify_host(host: &str, session: &WebFetchSessionConfig) -> SsrfDecision {
    let addresses = match resolve_host(host).await {
        Ok(addrs) => addrs,
        Err(e) => {
            return SsrfDecision::Blocked {
                reason: format!("DNS resolution failed: {}", e),
                hint: "Check that the hostname is reachable and correct.".to_string(),
            };
        }
    };
    if addresses.is_empty() {
        return SsrfDecision::Blocked {
            reason: "Hostname did not resolve to any address.".to_string(),
            hint: "Check DNS or try a different host.".to_string(),
        };
    }
    for addr in &addresses {
        if let Some(class) = classify_ip(*addr) {
            if !opted_in(class, session) {
                return SsrfDecision::Blocked {
                    reason: format!(
                        "Host resolved to blocked IP range: {} ({})",
                        addr,
                        class.as_str()
                    ),
                    hint: hint_for(class).to_string(),
                };
            }
        }
    }
    SsrfDecision::Allowed
}

/// Synchronous helper — reads the input string as an IP if possible,
/// classifies. Used by tests + by the host-resolver path (each resolved
/// address is fed in here).
pub fn classify_ip(addr: IpAddr) -> Option<BlockClass> {
    match addr {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

fn classify_v4(addr: Ipv4Addr) -> Option<BlockClass> {
    let [a, b, _, _] = addr.octets();
    // Loopback 127.0.0.0/8
    if a == 127 {
        return Some(BlockClass::Loopback);
    }
    // Link-local / metadata 169.254.0.0/16
    if a == 169 && b == 254 {
        return Some(BlockClass::Metadata);
    }
    // RFC 1918 private
    if a == 10 {
        return Some(BlockClass::Private);
    }
    if a == 172 && (16..=31).contains(&b) {
        return Some(BlockClass::Private);
    }
    if a == 192 && b == 168 {
        return Some(BlockClass::Private);
    }
    // 0.0.0.0/8 "this network"
    if a == 0 {
        return Some(BlockClass::Reserved);
    }
    if addr == Ipv4Addr::BROADCAST {
        return Some(BlockClass::Reserved);
    }
    // 100.64.0.0/10 CGNAT
    if a == 100 && (64..=127).contains(&b) {
        return Some(BlockClass::Private);
    }
    None
}

fn classify_v6(addr: Ipv6Addr) -> Option<BlockClass> {
    if addr == Ipv6Addr::LOCALHOST {
        return Some(BlockClass::Loopback);
    }
    if addr == Ipv6Addr::UNSPECIFIED {
        return Some(BlockClass::Reserved);
    }
    let segments = addr.segments();
    let first = segments[0];
    // fe80::/10 link-local
    if (first & 0xffc0) == 0xfe80 {
        return Some(BlockClass::LinkLocal);
    }
    // fc00::/7 unique local
    if (first & 0xfe00) == 0xfc00 {
        return Some(BlockClass::Private);
    }
    // ::ffff:0:0/96 IPv4-mapped — classify the inner v4
    if let Some(v4) = addr.to_ipv4_mapped() {
        return classify_v4(v4);
    }
    None
}

fn opted_in(class: BlockClass, session: &WebFetchSessionConfig) -> bool {
    match class {
        BlockClass::Loopback => session.allow_loopback,
        BlockClass::Private => session.allow_private_networks,
        BlockClass::LinkLocal => session.allow_private_networks || session.allow_metadata,
        BlockClass::Metadata => session.allow_metadata,
        BlockClass::Reserved => false,
    }
}

fn hint_for(class: BlockClass) -> &'static str {
    match class {
        BlockClass::Loopback => {
            "Loopback is blocked by default. If you need localhost for a developer workload, the session must set allow_loopback: true."
        }
        BlockClass::Private => {
            "Private IP ranges (RFC 1918) are blocked by default. Set session.allow_private_networks: true to enable."
        }
        BlockClass::LinkLocal => {
            "Link-local addresses are blocked by default. Set session.allow_private_networks or session.allow_metadata as appropriate."
        }
        BlockClass::Metadata => {
            "Cloud metadata endpoints (169.254.169.254) are blocked by default to prevent credential exfiltration. If this is intentional, set session.allow_metadata: true — but be aware of the security implications."
        }
        BlockClass::Reserved => {
            "Reserved / special-purpose IP range (0.0.0.0/8, broadcast, etc.) — not a useful target."
        }
    }
}

/// Resolve a host to IPs via tokio's blocking lookup_host. Short-circuits
/// if the host is already an IP literal.
pub async fn resolve_host(host: &str) -> Result<Vec<IpAddr>, String> {
    if let Ok(addr) = IpAddr::from_str(host) {
        return Ok(vec![addr]);
    }
    // lookup_host takes "host:port" — use a dummy port.
    let query = format!("{}:0", host);
    let res = tokio::net::lookup_host(query).await;
    match res {
        Ok(iter) => Ok(iter.map(|sa| sa.ip()).collect()),
        Err(e) => Err(e.to_string()),
    }
}
