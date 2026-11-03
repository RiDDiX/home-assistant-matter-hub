import type { ControllerType } from "@home-assistant-matter-hub/common";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import Box from "@mui/material/Box";
import type { FC, SVGProps } from "react";
import AmazonIcon from "../../assets/brands/Amazon.svg?react";
import AppleIcon from "../../assets/brands/Apple.svg?react";
import GoogleIcon from "../../assets/brands/Google.svg?react";

const brandIcons: Partial<Record<ControllerType, FC<SVGProps<SVGSVGElement>>>> =
  {
    apple_home: AppleIcon,
    google_home: GoogleIcon,
    alexa: AmazonIcon,
  };

export const ControllerIcon = ({ id }: { id: ControllerType }) => {
  const BrandIcon = brandIcons[id];
  if (!BrandIcon) {
    return <AltRouteIcon fontSize="small" color="action" aria-hidden />;
  }
  return (
    <Box
      component="span"
      aria-hidden
      sx={{ display: "flex", fill: (theme) => theme.palette.text.primary }}
    >
      <BrandIcon style={{ height: 20, width: "auto", maxWidth: 32 }} />
    </Box>
  );
};
