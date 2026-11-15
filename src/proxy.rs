//! 信任的反向代理（rucloud.toml 的 trusted_proxies）：只有從這些位址連進來的請求，
//! 才採用 X-Forwarded-For / X-Forwarded-Proto（以及 Cloudflare 的 CF-Connecting-IP），
//! 其他人自己帶的這些標頭一律不信，免得偽造 IP 躲過 Rate Limiting、或假裝是 HTTPS。

use anyhow::{Context, Result, bail};
use axum::http::HeaderMap;
use std::net::IpAddr;
use std::sync::OnceLock;

/// Cloudflare 公布的 IP 範圍（https://www.cloudflare.com/ips/），trusted_proxies 寫 "cloudflare" 時使用
const CLOUDFLARE: &[&str] = &[
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
];

#[derive(Debug, Clone)]
struct Net {
    addr: IpAddr,
    bits: u8,
    cloudflare: bool,
}

impl Net {
    fn parse(s: &str, cloudflare: bool) -> Result<Net> {
        let (a, b) = s.split_once('/').unwrap_or((s, ""));
        let addr: IpAddr = a.trim().parse().with_context(|| format!("trusted_proxies 的位址不對：{s}"))?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let bits = if b.is_empty() {
            max
        } else {
            b.parse().with_context(|| format!("trusted_proxies 的遮罩不對：{s}"))?
        };
        if bits > max {
            bail!("trusted_proxies 的遮罩不對：{s}");
        }
        Ok(Net { addr, bits, cloudflare })
    }

    fn contains(&self, ip: IpAddr) -> bool {
        let ip = match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
            v4 => v4,
        };
        match (self.addr, ip) {
            (IpAddr::V4(n), IpAddr::V4(i)) => {
                let mask = if self.bits == 0 { 0 } else { u32::MAX << (32 - self.bits) };
                u32::from(n) & mask == u32::from(i) & mask
            }
            (IpAddr::V6(n), IpAddr::V6(i)) => {
                let mask = if self.bits == 0 { 0 } else { u128::MAX << (128 - self.bits) };
                u128::from(n) & mask == u128::from(i) & mask
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Trusted {
    nets: Vec<Net>,
}

/// 預設信任本機（同一台機器上的 Caddy / nginx）
pub fn default_list() -> Vec<String> {
    vec!["127.0.0.1".into(), "::1".into()]
}

impl Trusted {
    pub fn new(list: &[String]) -> Result<Trusted> {
        let mut nets = Vec::new();
        for s in list {
            if s.eq_ignore_ascii_case("cloudflare") {
                for c in CLOUDFLARE {
                    nets.push(Net::parse(c, true)?);
                }
            } else {
                nets.push(Net::parse(s, false)?);
            }
        }
        Ok(Trusted { nets })
    }

    fn find(&self, ip: IpAddr) -> Option<&Net> {
        self.nets.iter().find(|n| n.contains(ip))
    }

    /// 真正的使用者 IP，以及可以採信的 X-Forwarded-Proto
    pub fn resolve(&self, peer: IpAddr, headers: &HeaderMap) -> (IpAddr, Option<String>) {
        let Some(net) = self.find(peer) else { return (peer, None) };
        let proto = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(',').next().unwrap_or("").trim().to_ascii_lowercase())
            .filter(|s| s == "http" || s == "https");
        // 直接從 Cloudflare 連進來：用它給的 CF-Connecting-IP
        if net.cloudflare
            && let Some(ip) = headers
                .get("cf-connecting-ip")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse().ok())
        {
            return (ip, proto);
        }
        // X-Forwarded-For 由右往左，跳過信任的代理，第一個不信任的就是使用者
        let chain: Vec<IpAddr> = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|s| s.split(','))
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let client = chain
            .iter()
            .rev()
            .find(|ip| self.find(**ip).is_none())
            .or(chain.first())
            .copied()
            .unwrap_or(peer);
        (client, proto)
    }
}

static TRUSTED: OnceLock<Trusted> = OnceLock::new();

pub fn init(list: &[String]) -> Result<()> {
    let t = Trusted::new(list)?;
    let _ = TRUSTED.set(t);
    Ok(())
}

pub fn get() -> &'static Trusted {
    TRUSTED.get_or_init(|| Trusted::new(&default_list()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        m
    }

    #[test]
    fn resolve() {
        let t = Trusted::new(&["127.0.0.1".into(), "10.0.0.0/8".into(), "cloudflare".into()]).unwrap();
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        // 不信任的人自己帶的標頭不算
        assert_eq!(
            t.resolve(
                ip("203.0.113.9"),
                &h(&[("x-forwarded-for", "1.2.3.4"), ("x-forwarded-proto", "https")])
            ),
            (ip("203.0.113.9"), None)
        );
        // 本機的 Caddy
        assert_eq!(
            t.resolve(
                ip("127.0.0.1"),
                &h(&[("x-forwarded-for", "198.51.100.7"), ("x-forwarded-proto", "https")])
            ),
            (ip("198.51.100.7"), Some("https".into()))
        );
        // 多層代理：使用者偽造的最左邊不算，取最右邊不信任的
        assert_eq!(
            t.resolve(ip("10.0.0.2"), &h(&[("x-forwarded-for", "6.6.6.6, 198.51.100.7, 10.0.0.5")]))
                .0,
            ip("198.51.100.7")
        );
        // Cloudflare
        assert_eq!(
            t.resolve(ip("104.16.1.1"), &h(&[("cf-connecting-ip", "198.51.100.8")])).0,
            ip("198.51.100.8")
        );
        // 不是從 Cloudflare 來的，CF-Connecting-IP 不算
        assert_eq!(
            t.resolve(ip("127.0.0.1"), &h(&[("cf-connecting-ip", "6.6.6.6")])).0,
            ip("127.0.0.1")
        );
        assert!(
            t.resolve(ip("::ffff:127.0.0.1"), &h(&[("x-forwarded-proto", "https")])).1.is_some(),
            "IPv4-mapped"
        );
        assert!(Trusted::new(&["10.0.0.0/40".into()]).is_err());
    }
}
