//! 應用清單：設定檔裡的應用，加上執行中透過管理 API 新增的應用（`[dynamic]`）。
//! 綁定 API、edge、管理 API、部署、自動憑證都查這裡，所以新增或刪除的應用馬上生效。
//!
//! 每個應用的網域（hosts）來自：rucloud.toml 的 hosts、wrangler 的 routes、[domain] 的 <名稱>.<base>。

use crate::app::Slot;
use crate::config::DomainCfg;
use anyhow::{Result, bail};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, RwLock};

/// 應用的來源
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// rucloud.toml 裡的應用
    Config,
    /// 用完整的管理 token 部署時自動新增的應用（自己的程式碼，可以用所有綁定）
    Managed,
    /// [dynamic]：替使用者執行的程式碼（不可信，綁定有限制）
    Dynamic,
    /// [install]：安裝的應用（不可信，綁定有限制，權限由安裝程式給）
    Installed,
}

impl Kind {
    /// 不可信的程式碼：只能用不會碰到其他應用的綁定，不採用 wrangler 的 routes
    pub fn restricted(self) -> bool {
        matches!(self, Kind::Dynamic | Kind::Installed)
    }
}

#[derive(Default)]
pub struct Registry {
    apps: RwLock<BTreeMap<String, Arc<Slot>>>,
    /// 網域 → 應用（精確比對；自動憑證只發給這裡有的網域）
    hosts: RwLock<HashMap<String, Arc<Slot>>>,
    /// 執行中新增的應用名稱
    dynamic: RwLock<BTreeSet<String>>,
    managed: RwLock<BTreeSet<String>>,
    installed: RwLock<BTreeSet<String>>,
    /// 保留的網域（例如管理介面的 [admin] host）：應用不能用，但會申請憑證
    reserved: RwLock<BTreeSet<String>>,
    pub domain: Option<DomainCfg>,
}

impl Registry {
    pub fn new(domain: Option<DomainCfg>) -> Self {
        Registry {
            domain,
            ..Default::default()
        }
    }

    /// 這個應用該有的網域。執行中新增的應用不採用 wrangler 的 routes（不能自己宣告別人的網域）
    pub fn hosts_for(&self, slot: &Slot, dynamic: bool) -> Vec<String> {
        self.hosts_for_cfg(slot, &slot.get().cfg, dynamic)
    }

    /// 同上，但用指定的 wrangler 設定（換版前先檢查新版本的 routes）
    pub fn hosts_for_cfg(&self, slot: &Slot, cfg: &crate::config::Wrangler, dynamic: bool) -> Vec<String> {
        let mut out: Vec<String> = slot.entry.hosts.iter().map(|h| h.to_ascii_lowercase()).collect();
        if !dynamic {
            out.extend(cfg.route_hosts());
        }
        if let Some(d) = &self.domain {
            let base = d.base.trim_matches('.').to_ascii_lowercase();
            out.push(format!("{}.{base}", slot.name));
            if d.root.as_deref() == Some(slot.name.as_str()) {
                out.push(base);
            }
        }
        out.sort();
        out.dedup();
        out
    }

    pub fn insert(&self, slot: Arc<Slot>, kind: Kind) -> Result<()> {
        let hosts = self.hosts_for(&slot, kind.restricted());
        self.check_hosts(&slot.name, &hosts)?;
        match kind {
            Kind::Dynamic => self.dynamic.write().unwrap().insert(slot.name.clone()),
            Kind::Managed => self.managed.write().unwrap().insert(slot.name.clone()),
            Kind::Installed => self.installed.write().unwrap().insert(slot.name.clone()),
            Kind::Config => true,
        };
        self.apps.write().unwrap().insert(slot.name.clone(), slot.clone());
        self.set_hosts(&slot, hosts);
        Ok(())
    }

    /// 網域不能和其他應用重複
    pub fn check_hosts(&self, name: &str, hosts: &[String]) -> Result<()> {
        let map = self.hosts.read().unwrap();
        let reserved = self.reserved.read().unwrap();
        for h in hosts {
            if reserved.contains(h) {
                bail!("網域 {h} 保留給 rucloud（例如管理介面）");
            }
            if let Some(other) = map.get(h)
                && other.name != name
            {
                bail!("網域 {h} 已經給了應用 {}", other.name);
            }
        }
        Ok(())
    }

    /// 換版後重新計算網域（routes 可能改了）
    pub fn refresh_hosts(&self, slot: &Arc<Slot>) -> Result<()> {
        let hosts = self.hosts_for(slot, self.kind(&slot.name).restricted());
        self.check_hosts(&slot.name, &hosts)?;
        self.set_hosts(slot, hosts);
        Ok(())
    }

    fn set_hosts(&self, slot: &Arc<Slot>, hosts: Vec<String>) {
        let mut map = self.hosts.write().unwrap();
        map.retain(|_, s| !Arc::ptr_eq(s, slot));
        for h in hosts {
            map.insert(h, slot.clone());
        }
    }

    pub fn remove(&self, name: &str) -> Option<Arc<Slot>> {
        let slot = self.apps.write().unwrap().remove(name)?;
        self.hosts.write().unwrap().retain(|_, s| !Arc::ptr_eq(s, &slot));
        self.dynamic.write().unwrap().remove(name);
        self.managed.write().unwrap().remove(name);
        self.installed.write().unwrap().remove(name);
        Some(slot)
    }

    pub fn get(&self, name: &str) -> Option<Arc<Slot>> {
        self.apps.read().unwrap().get(name).cloned()
    }

    pub fn all(&self) -> Vec<(String, Arc<Slot>)> {
        self.apps.read().unwrap().iter().map(|(n, s)| (n.clone(), s.clone())).collect()
    }

    /// 某個應用目前的網域
    pub fn hosts_of(&self, name: &str) -> Vec<String> {
        let mut v: Vec<String> = self
            .hosts
            .read()
            .unwrap()
            .iter()
            .filter(|(_, s)| s.name == name)
            .map(|(h, _)| h.clone())
            .collect();
        v.sort();
        v
    }

    /// 所有應用的網域與保留的網域（自動憑證用）
    pub fn all_hosts(&self) -> Vec<String> {
        let mut v: Vec<String> = self.hosts.read().unwrap().keys().cloned().collect();
        v.extend(self.reserved.read().unwrap().iter().cloned());
        v.sort();
        v
    }

    /// 精確比對網域（應用的或保留的）
    pub fn owns_host(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.hosts.read().unwrap().contains_key(&host) || self.reserved.read().unwrap().contains(&host)
    }

    pub fn reserve(&self, host: &str) {
        self.reserved.write().unwrap().insert(host.to_ascii_lowercase());
    }

    /// edge 用：先精確比對網域，再用第一段當應用名稱（myapp.localhost → myapp，開發時方便）
    pub fn by_host(&self, host: &str) -> Option<Arc<Slot>> {
        let host = host.to_ascii_lowercase();
        if let Some(s) = self.hosts.read().unwrap().get(&host) {
            return Some(s.clone());
        }
        self.apps.read().unwrap().get(host.split('.').next().unwrap_or("")).cloned()
    }

    pub fn is_dynamic(&self, name: &str) -> bool {
        self.dynamic.read().unwrap().contains(name)
    }

    pub fn is_managed(&self, name: &str) -> bool {
        self.managed.read().unwrap().contains(name)
    }

    pub fn kind(&self, name: &str) -> Kind {
        if self.is_dynamic(name) {
            Kind::Dynamic
        } else if self.installed.read().unwrap().contains(name) {
            Kind::Installed
        } else if self.is_managed(name) {
            Kind::Managed
        } else {
            Kind::Config
        }
    }

    pub fn dynamic_count(&self) -> usize {
        self.dynamic.read().unwrap().len()
    }

    pub fn installed_count(&self) -> usize {
        self.installed.read().unwrap().len()
    }
}
