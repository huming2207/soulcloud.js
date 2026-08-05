import { forwardRef, type Ref } from "react";
import {
  Link as RouterLink,
  type LinkProps as RouterLinkProps,
} from "react-router-dom";
import { createTheme } from "@mui/material/styles";
import type { LinkProps } from "@mui/material/Link";

/**
 * Maps Material UI `href` to react-router `to` so that every MUI link and
 * button navigates client-side (see mui.com/material-ui/integrations/routing).
 */
const LinkBehavior = forwardRef<
  HTMLAnchorElement,
  Omit<RouterLinkProps, "to"> & { href: RouterLinkProps["to"] }
>((props, ref) => {
  const { href, ...other } = props;
  return <RouterLink ref={ref} to={href} {...other} />;
});
LinkBehavior.displayName = "LinkBehavior";

export const theme = createTheme({
  // MUI v6 CSS-variable color schemes: light + dark, following the system
  // by default (toggled at runtime via useColorScheme()).
  colorSchemes: { light: true, dark: true },
  components: {
    MuiLink: {
      defaultProps: {
        component: LinkBehavior,
      } as LinkProps,
    },
    MuiButtonBase: {
      defaultProps: {
        LinkComponent: LinkBehavior,
      },
    },
  },
});
