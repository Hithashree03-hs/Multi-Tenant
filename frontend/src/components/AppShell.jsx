import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { apiRequest } from "../api/client.js";
import { Alert, initials } from "./ui.jsx";

const NAV_ITEMS = [
  { label: "Overview", path: "/", glyph: "⌂", roles: ["ADMIN", "FACULTY", "STUDENT"] },
  { label: "Organization", path: "/organization", glyph: "◫", roles: ["ADMIN", "FACULTY", "STUDENT"] },
  { label: "Departments", path: "/departments", glyph: "▦", roles: ["ADMIN", "FACULTY", "STUDENT"] },
  { label: "People", path: "/users", glyph: "♙", roles: ["ADMIN", "FACULTY"] },
  { label: "Courses", path: "/courses", glyph: "▤", roles: ["ADMIN", "FACULTY", "STUDENT"] },
  { label: "My enrollments", path: "/enrollments", glyph: "✓", roles: ["STUDENT"] },
  { label: "Attendance", path: "/attendance", glyph: "◷", roles: ["ADMIN", "FACULTY", "STUDENT"] },
  { label: "Projects", path: "/projects", glyph: "◈", roles: ["ADMIN", "FACULTY", "STUDENT"] },
  { label: "Notifications", path: "/notifications", glyph: "◌", roles: ["ADMIN", "FACULTY", "STUDENT"] },
];

export default function AppShell() {
  const { user, token, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [notificationError, setNotificationError] = useState(false);
  const profileMenuRef = useRef(null);
  const profileTriggerRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!profileMenuOpen) return undefined;
    function closeOnOutsidePointer(event) {
      if (!profileMenuRef.current?.contains(event.target)) setProfileMenuOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") {
        setProfileMenuOpen(false);
        profileTriggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);

  useEffect(() => setProfileMenuOpen(false), [location.pathname]);

  useEffect(() => {
    let active = true;
    apiRequest("/notifications?unread=true&limit=1", { token })
      .then((result) => { if (active) { setUnread(result.unreadCount || 0); setNotificationError(false); } })
      .catch(() => { if (active) { setUnread(0); setNotificationError(true); } });
    return () => { active = false; };
  }, [token]);

  function signOut() { logout(); navigate("/login", { replace: true }); }
  function switchAccount() {
    logout();
    navigate("/login", { replace: true, state: { message: "Sign in with another account." } });
  }
  const links = NAV_ITEMS.filter((item) => item.roles.includes(user?.role));

  return <div className="app-layout">
    {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
      <div className="sidebar-brand"><span className="brand-mark">C</span><span>CampusFlow <b>Pro</b></span><button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close menu">×</button></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {links.map((item) => <NavLink key={item.path} to={item.path} end={item.path === "/"} onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-link ${isActive ? "nav-active" : ""}`}>
          <span className="nav-glyph" aria-hidden="true">{item.glyph}</span><span>{item.label}</span>
          {item.path === "/notifications" && unread > 0 && <span className="nav-count">{unread > 9 ? "9+" : unread}</span>}
        </NavLink>)}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-help"><div className="help-orb">✦</div><strong>Need a hand?</strong><p>Talk to your campus administrator for account or access help.</p></div>
        <div className="sidebar-user"><span className="avatar">{initials(user?.name)}</span><div className="sidebar-user-copy"><strong>{user?.name}</strong><span>{user?.role?.toLowerCase()}</span></div><button className="icon-button signout-button" title="Sign out" aria-label="Sign out" onClick={signOut}>↗</button></div>
      </div>
    </aside>
    <div className="main-column">
      <header className="topbar"><button className="icon-button menu-toggle" onClick={() => setMobileOpen(true)} aria-label="Open navigation">☰</button>
        <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-divider">/</span><strong>Campus dashboard</strong></div>
        <div className="topbar-actions"><NavLink className="topbar-icon" to="/notifications" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}><span>{"\u2667"}</span>{unread > 0 && <i />}</NavLink>
          <div className="profile-menu" ref={profileMenuRef}>
            <button ref={profileTriggerRef} type="button" className="topbar-user profile-menu-trigger" aria-label={profileMenuOpen ? "Close account menu" : "Open account menu"} aria-expanded={profileMenuOpen} aria-controls="profile-menu" onClick={() => setProfileMenuOpen((open) => !open)}>
              <span className="avatar avatar-small">{initials(user?.name)}</span>
              <span className="profile-menu-trigger-copy"><strong>{user?.name}</strong><span>{user?.role}</span></span>
              <span className="profile-menu-caret" aria-hidden="true">{"\u2304"}</span>
            </button>
            {profileMenuOpen && <div className="profile-menu-panel" id="profile-menu" aria-label="Account options">
              <div className="profile-menu-identity"><strong>{user?.name}</strong><span>{user?.email}</span><span className="profile-menu-role">{user?.role}</span></div>
              <div className="profile-menu-divider" />
              <button type="button" className="profile-menu-action" onClick={switchAccount}>Switch account</button>
              <button type="button" className="profile-menu-action profile-menu-logout" onClick={signOut}>Log out</button>
            </div>}
          </div>
        </div>
      </header>
      {notificationError && <div className="shell-notice"><Alert variant="info">Unread notification count is temporarily unavailable.</Alert></div>}
      <main className="main-content"><Outlet /></main>
      <footer className="app-footer"><span>CampusFlow Pro</span><span>Campus work, connected.</span></footer>
    </div>
  </div>;
}
