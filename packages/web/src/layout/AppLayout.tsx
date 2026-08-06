import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Select, { type SelectChangeEvent } from "@mui/material/Select";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useColorScheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import DashboardIcon from "@mui/icons-material/Dashboard";
import DevicesIcon from "@mui/icons-material/Devices";
import ArticleIcon from "@mui/icons-material/Article";
import MemoryIcon from "@mui/icons-material/Memory";
import UpdateIcon from "@mui/icons-material/Update";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import LogoutIcon from "@mui/icons-material/Logout";
import MenuIcon from "@mui/icons-material/Menu";
import { useAuth } from "../auth/AuthContext";
import { useProject } from "./ProjectContext";
import { useI18n } from "../i18n/I18nContext";
import type { DictKey } from "../i18n/dictionary";
import TranslateIcon from "@mui/icons-material/Translate";

const DRAWER_WIDTH = 240;

const LANG_OPTIONS = [
  { locale: "zh", labelKey: "layout.langZh" as DictKey },
  { locale: "en", labelKey: "layout.langEn" as DictKey },
  { locale: "ru", labelKey: "layout.langRu" as DictKey },
  { locale: "uk", labelKey: "layout.langUk" as DictKey },
] as const;

const NAV_ITEMS = [
  { path: "/", labelKey: "nav.dashboard" as DictKey, icon: <DashboardIcon /> },
  { path: "/devices", labelKey: "nav.devices" as DictKey, icon: <DevicesIcon /> },
  { path: "/logs", labelKey: "nav.logs" as DictKey, icon: <ArticleIcon /> },
  { path: "/firmware", labelKey: "nav.firmware" as DictKey, icon: <MemoryIcon /> },
  { path: "/rollouts", labelKey: "nav.rollouts" as DictKey, icon: <UpdateIcon /> },
] as const;

/** AppBar title: exact nav match, then detail-page patterns. */
function pageTitle(pathname: string, t: (k: DictKey) => string): string {
  const exact = NAV_ITEMS.find((i) => i.path === pathname);
  if (exact) return t(exact.labelKey);
  if (/^\/devices\/[^/]+$/.test(pathname)) return t("title.deviceDetail");
  if (/^\/rollouts\/[^/]+$/.test(pathname)) return t("title.rolloutDetail");
  if (/^\/ota-jobs\/[^/]+$/.test(pathname)) return t("title.otaJob");
  return "Soulcloud";
}

export function AppLayout() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();
  const { projects, projectId, setProjectId } = useProject();
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const { mode, setMode, systemMode } = useColorScheme();
  const [userMenuAnchor, setUserMenuAnchor] = useState<null | HTMLElement>(null);
  const [langAnchor, setLangAnchor] = useState<null | HTMLElement>(null);

  // mode is undefined on first render; fall back to the resolved system mode
  const isDark = mode === "dark" || (mode === undefined && systemMode === "dark");

  const handleLogout = async () => {
    setUserMenuAnchor(null);
    await logout();
    navigate("/login", { replace: true });
  };

  const handleProjectChange = (event: SelectChangeEvent) => {
    // SelectChangeEvent's target is a union; Select<string> narrows to string
    setProjectId(event.target.value as string);
  };

  const sidebar = (
    <>
      <Toolbar>
        <Typography variant="h6" noWrap component="div" sx={{ fontWeight: 700 }}>
          Soulcloud
        </Typography>
      </Toolbar>
      <Divider />
      <List sx={{ px: 1 }}>
        {NAV_ITEMS.map((item) => (
          <ListItem key={item.path} disablePadding sx={{ display: "block" }}>
            <ListItemButton
              component={NavLink}
              to={item.path}
              end={item.path === "/"}
              onClick={() => setMobileOpen(false)}
              sx={{
                borderRadius: 1,
                "&.active": {
                  bgcolor: "action.selected",
                  fontWeight: 600,
                },
              }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
              <ListItemText primary={t(item.labelKey)} />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          zIndex: (t) => t.zIndex.drawer + 1,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          color: "text.primary",
        }}
      >
        <Toolbar>
          {isMobile && (
            <IconButton
              edge="start"
              color="inherit"
              aria-label={t("layout.openNav")}
              onClick={() => setMobileOpen(true)}
              sx={{ mr: 1 }}
            >
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="h6" noWrap sx={{ fontWeight: 600, mr: 3 }}>
            {pageTitle(location.pathname, t)}
          </Typography>

          <Box sx={{ flexGrow: 1 }} />

          {/* project selector */}
          {projects.length > 0 && (
            <Select<string>
              size="small"
              value={projectId ?? ""}
              onChange={handleProjectChange}
              sx={{ minWidth: 200, mr: 2 }}
              aria-label={t("layout.selectProject")}
            >
              {projects.map((p) => (
                <MenuItem key={p.project_id} value={p.project_id}>
                  {p.name}
                </MenuItem>
              ))}
            </Select>
          )}

          {/* language toggle */}
          <Tooltip title={t("layout.lang")}>
            <IconButton
              color="inherit"
              onClick={(e) => setLangAnchor(e.currentTarget)}
              aria-label={t("layout.lang")}
              aria-haspopup="true"
            >
              <TranslateIcon />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={langAnchor}
            open={Boolean(langAnchor)}
            onClose={() => setLangAnchor(null)}
          >
            {LANG_OPTIONS.map((opt) => (
              <MenuItem
                key={opt.locale}
                selected={locale === opt.locale}
                onClick={() => {
                  setLangAnchor(null);
                  setLocale(opt.locale);
                }}
              >
                {t(opt.labelKey)}
              </MenuItem>
            ))}
          </Menu>

          {/* dark mode toggle */}
          <Tooltip title={isDark ? t("layout.switchLight") : t("layout.switchDark")}>
            <IconButton
              color="inherit"
              onClick={() => setMode(isDark ? "light" : "dark")}
            >
              {isDark ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>

          {/* user menu */}
          <Tooltip title={t("layout.account")}>
            <IconButton
              onClick={(e) => setUserMenuAnchor(e.currentTarget)}
              aria-haspopup="true"
            >
              <Avatar sx={{ width: 32, height: 32, fontSize: 14 }}>
                {user?.username.slice(0, 1).toUpperCase()}
              </Avatar>
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={userMenuAnchor}
            open={Boolean(userMenuAnchor)}
            onClose={() => setUserMenuAnchor(null)}
          >
            <MenuItem disabled sx={{ opacity: 1 }}>
              <Typography variant="body2">{user?.username}</Typography>
            </MenuItem>
            <MenuItem onClick={handleLogout}>
              <ListItemIcon>
                <LogoutIcon fontSize="small" />
              </ListItemIcon>
              {t("layout.logout")}
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      {/* mobile drawer */}
      {isMobile && (
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ "& .MuiDrawer-paper": { width: DRAWER_WIDTH } }}
        >
          {sidebar}
        </Drawer>
      )}
      {/* desktop drawer */}
      {!isMobile && (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" },
          }}
        >
          {sidebar}
        </Drawer>
      )}

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 3,
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
        }}
      >
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
