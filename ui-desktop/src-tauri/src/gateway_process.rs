use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use tauri_plugin_shell::process::CommandChild;

pub struct ManagedGateway {
    pub child: CommandChild,
    pub exited: Arc<AtomicBool>,
    guard: ProcessGuard,
}

impl ManagedGateway {
    pub fn new(child: CommandChild) -> Result<Self, String> {
        let guard = match ProcessGuard::attach(child.pid()) {
            Ok(guard) => guard,
            Err(error) => { let _ = child.kill(); return Err(error); }
        };
        Ok(Self { child, exited: Arc::new(AtomicBool::new(false)), guard })
    }
    pub fn pid(&self) -> u32 { self.child.pid() }
}

/// Request cleanup while the runtime can still cancel tools, save and reap.
/// The bounded fallback owns descendants too, even after the parent exits.
pub fn stop_gateways(mut gateways: Vec<ManagedGateway>) {
    for gateway in &mut gateways {
        gateway.guard.observe(gateway.pid());
        let _ = gateway.child.write(b"{\"jsonrpc\":\"2.0\",\"method\":\"gateway.shutdown\"}\n");
    }
    let until = Instant::now() + Duration::from_secs(4);
    while gateways.iter().any(|gateway| !gateway.exited.load(Ordering::Acquire)) && Instant::now() < until {
        for gateway in &mut gateways {
            if !gateway.exited.load(Ordering::Acquire) { gateway.guard.observe(gateway.pid()); }
        }
        thread::sleep(Duration::from_millis(25));
    }
    for gateway in gateways {
        if !gateway.exited.load(Ordering::Acquire) { let _ = gateway.child.kill(); }
        gateway.guard.finish();
    }
}

#[cfg(windows)]
struct ProcessGuard(usize);

#[cfg(windows)]
impl ProcessGuard {
    fn attach(pid: u32) -> Result<Self, String> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::{JobObjects::*, Threading::*}};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0 {
                let error = std::io::Error::last_os_error(); CloseHandle(job); return Err(error.to_string());
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() { let error = std::io::Error::last_os_error(); CloseHandle(job); return Err(error.to_string()); }
            let assigned = AssignProcessToJobObject(job, process);
            let error = std::io::Error::last_os_error();
            CloseHandle(process);
            if assigned == 0 { CloseHandle(job); return Err(format!("Cannot own gateway process tree: {error}")); }
            Ok(Self(job as usize))
        }
    }
    fn observe(&mut self, _pid: u32) {}
    fn finish(self) {} // Drop closes the job and kills any remaining descendants.
}

#[cfg(windows)]
impl Drop for ProcessGuard {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _); } }
}

#[cfg(unix)]
struct ProcessGuard {
    root: (u32, String),
    owned: std::collections::HashMap<u32, String>,
}

#[cfg(unix)]
impl ProcessGuard {
    fn snapshot() -> Vec<(u32, u32, String)> {
        let Ok(output) = std::process::Command::new("ps").args(["-eo", "pid=,ppid=,lstart="]).output() else { return Vec::new(); };
        String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
            let mut words = line.split_whitespace();
            let pid: u32 = words.next()?.parse().ok()?;
            let ppid: u32 = words.next()?.parse().ok()?;
            let identity = words.collect::<Vec<_>>().join(" ");
            if identity.is_empty() { return None; }
            #[cfg(target_os = "linux")]
            let identity = {
                let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
                let ticks = stat.rsplit_once(") ")?.1.split_whitespace().nth(19)?;
                format!("{identity}:{ticks}")
            };
            Some((pid, ppid, identity))
        }).collect()
    }
    fn attach(pid: u32) -> Result<Self, String> {
        let identity = Self::snapshot().into_iter().find(|entry| entry.0 == pid)
            .map(|entry| entry.2).ok_or_else(|| "Cannot identify gateway process".to_string())?;
        Ok(Self { root: (pid, identity), owned: std::collections::HashMap::new() })
    }
    fn observe(&mut self, _root: u32) {
        let pairs = Self::snapshot();
        let same_process = |pid: u32, identity: &str| pairs.iter().any(|entry| entry.0 == pid && entry.2 == identity);
        let mut parents: Vec<u32> = self.owned.iter().filter(|(pid, identity)| same_process(**pid, identity)).map(|(pid, _)| *pid).collect();
        if same_process(self.root.0, &self.root.1) { parents.push(self.root.0); }
        let mut visited = std::collections::HashSet::new();
        while let Some(parent) = parents.pop() {
            if !visited.insert(parent) { continue; }
            for (pid, ppid, identity) in &pairs {
                if *ppid == parent && *pid > 1 && *pid != std::process::id() {
                    self.owned.insert(*pid, identity.clone()); parents.push(*pid);
                }
            }
        }
    }
    fn signal_owned(&self, signal: i32) {
        let live = Self::snapshot();
        for (&pid, identity) in &self.owned {
            if live.iter().any(|entry| entry.0 == pid && &entry.2 == identity) {
                unsafe { libc::kill(pid as i32, signal); }
            }
        }
    }
    fn finish(self) {
        self.signal_owned(libc::SIGTERM);
        if !self.owned.is_empty() { thread::sleep(Duration::from_millis(100)); }
        self.signal_owned(libc::SIGKILL);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};

    fn alive(pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() { return false; }
            let mut code = 0;
            let active = GetExitCodeProcess(process, &mut code) != 0 && code == 259;
            CloseHandle(process); active
        }
    }

    #[test]
    fn dropping_gateway_ownership_kills_a_detached_descendant() {
        let marker = std::env::temp_dir().join(format!("friday-owned-descendant-{}-{}.txt", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let script = "setTimeout(()=>{const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(process.argv[1],String(c.pid))},500);setInterval(()=>{},1000)";
        let mut child = std::process::Command::new("node").args(["-e", script]).arg(&marker).creation_flags(0x08000000).spawn().unwrap();
        let guard = ProcessGuard::attach(child.id()).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < until { thread::sleep(Duration::from_millis(20)); }
        let pid: u32 = std::fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
        assert!(alive(pid));
        drop(guard);
        child.wait().unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        while alive(pid) && Instant::now() < until { thread::sleep(Duration::from_millis(20)); }
        assert!(!alive(pid), "detached descendant survived job close");
        std::fs::remove_file(marker).unwrap();
    }
}
