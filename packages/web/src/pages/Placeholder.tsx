import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";

/** Temporary page body for features that arrive in P2/P3. */
export function Placeholder({
  title,
  description,
}: {
  title: string;
  description: ReactNode;
}) {
  return (
    <Card sx={{ maxWidth: 640 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
      </CardContent>
    </Card>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        py: 8,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1,
        color: "text.secondary",
      }}
    >
      {children}
    </Box>
  );
}
