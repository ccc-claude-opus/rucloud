//! 應用清單：設定檔裡的應用，加上執行中透過管理 API 新增的應用（`[dynamic]`）。
//! 綁定 API、edge、管理 API、部署都查這裡，所以新增或刪除的應用馬上生效。

use crate::app::Slot;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, RwLock};

#[derive(Default)]
pub struct Registry {
    apps: RwLock<BTreeMap<String, Arc<Slot>>>,
    /// rucloud.toml 的 hosts（額外的主機名稱）
    hosts: RwLock<HashMap<String, Arc<Slot>>>,
    /// 執行中新增的應用名稱
    dynamic: RwLock<BTreeSet<String>>,
}

impl Registry {
    pub fn insert(&self, slot: Arc<Slot>, hosts: &[String], dynamic: bool) {
        let mut h = self.hosts.write().unwrap();
        for host in hosts {
            h.insert(host.clone(), slot.clone());
        }
        if dynamic {
            self.dynamic.write().unwrap().insert(slot.name.clone());
        }
        self.apps.write().unwrap().insert(slot.name.clone(), slot);
    }

    pub fn remove(&self, name: &str) -> Option<Arc<Slot>> {
        let slot = self.apps.write().unwrap().remove(name)?;
        self.hosts.write().unwrap().retain(|_, s| !Arc::ptr_eq(s, &slot));
        self.dynamic.write().unwrap().remove(name);
        Some(slot)
    }

    pub fn get(&self, name: &str) -> Option<Arc<Slot>> {
        self.apps.read().unwrap().get(name).cloned()
    }

    pub fn all(&self) -> Vec<(String, Arc<Slot>)> {
        self.apps.read().unwrap().iter().map(|(n, s)| (n.clone(), s.clone())).collect()
    }

    /// edge 用：完整的主機名稱，再來是第一段（myapp.localhost → myapp）
    pub fn by_host(&self, host: &str) -> Option<Arc<Slot>> {
        let (apps, hosts) = (self.apps.read().unwrap(), self.hosts.read().unwrap());
        let lookup = |k: &str| hosts.get(k).or_else(|| apps.get(k)).cloned();
        lookup(host).or_else(|| lookup(host.split('.').next().unwrap_or("")))
    }

    pub fn is_dynamic(&self, name: &str) -> bool {
        self.dynamic.read().unwrap().contains(name)
    }

    pub fn dynamic_count(&self) -> usize {
        self.dynamic.read().unwrap().len()
    }
}
