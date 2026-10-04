import type { BridgeFabric } from "@home-assistant-matter-hub/common";
import QuestionMark from "@mui/icons-material/QuestionMark";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import { type FC, type SVGProps, useMemo } from "react";
import AmazonIcon from "../../assets/brands/Amazon.svg?react";
import AnkerIcon from "../../assets/brands/Anker.svg?react";
import AppleIcon from "../../assets/brands/Apple.svg?react";
import AqaraIcon from "../../assets/brands/Aqara.svg?react";
import AVMIcon from "../../assets/brands/AVM.svg?react";
import DLinkIcon from "../../assets/brands/D-Link.svg?react";
import DreameIcon from "../../assets/brands/Dreame.svg?react";
import GoogleIcon from "../../assets/brands/Google.svg?react";
import IKEAIcon from "../../assets/brands/IKEA.svg?react";
import iRobotIcon from "../../assets/brands/iRobot.svg?react";
import LGElectronicsIcon from "../../assets/brands/LG Electronics.svg?react";
import LidlIcon from "../../assets/brands/Lidl.svg?react";
import MerossIcon from "../../assets/brands/Meross.svg?react";
import NukiIcon from "../../assets/brands/Nuki.svg?react";
import PanasonicIcon from "../../assets/brands/Panasonic.svg?react";
import RazerIcon from "../../assets/brands/Razer.svg?react";
import RoborockIcon from "../../assets/brands/Roborock.svg?react";
import SamsungIcon from "../../assets/brands/Samsung.svg?react";
import SamsungSmartThingsIcon from "../../assets/brands/Samsung SmartThings.svg?react";
import ShellyIcon from "../../assets/brands/Shelly.svg?react";
import SignifyIcon from "../../assets/brands/Signify.svg?react";
import TPLinkIcon from "../../assets/brands/TP-Link.svg?react";
import TuyaIcon from "../../assets/brands/Tuya.svg?react";
import XiaomiIcon from "../../assets/brands/Xiaomi.svg?react";
import YandexIcon from "../../assets/brands/Yandex.svg?react";
import { getVendorName } from "./vendor-names.ts";

export interface FabricIconProps {
  fabric: BridgeFabric;
}

const iconsPerKeyword: Record<string, FC<SVGProps<SVGSVGElement>>> = {
  Alexa: AmazonIcon,
  Amazon: AmazonIcon,
  Apple: AppleIcon,
  Google: GoogleIcon,
  SmartThings: SamsungSmartThingsIcon,
  Samsung: SamsungIcon,
  IKEA: IKEAIcon,
  Tuya: TuyaIcon,
  Xiaomi: XiaomiIcon,
  Aqara: AqaraIcon,
  Shelly: ShellyIcon,
  Meross: MerossIcon,
};

const iconPerVendorId: Record<number, FC<SVGProps<SVGSVGElement>> | undefined> =
  {
    1: PanasonicIcon,
    4107: SignifyIcon,
    4142: LGElectronicsIcon,
    4321: SamsungIcon,
    4362: SamsungSmartThingsIcon,
    4447: AqaraIcon,
    4469: DLinkIcon,
    4476: IKEAIcon,
    4488: TPLinkIcon,
    4631: AmazonIcon,
    4701: TuyaIcon,
    4718: XiaomiIcon,
    4745: LidlIcon,
    4757: AVMIcon,
    4911: YandexIcon,
    4933: MerossIcon,
    4937: AppleIcon,
    4957: NukiIcon,
    4987: AmazonIcon,
    4993: AmazonIcon,
    4996: AppleIcon,
    5009: TPLinkIcon,
    5010: TPLinkIcon,
    5023: RazerIcon,
    5248: RoborockIcon,
    5264: ShellyIcon,
    5420: DreameIcon,
    5398: iRobotIcon,
    5427: AnkerIcon,
    24582: GoogleIcon,
  };

function getIcon(fabric: BridgeFabric) {
  const icon = iconPerVendorId[fabric.rootVendorId];
  if (icon) {
    return icon;
  }
  return Object.entries(iconsPerKeyword).find(([keyword]) =>
    fabric.label.toUpperCase().includes(keyword.toUpperCase()),
  )?.[1];
}

export const FabricIcon = ({ fabric }: FabricIconProps) => {
  const BrandIcon = useMemo(() => getIcon(fabric), [fabric]);
  return (
    <Tooltip
      title={`${fabric.label || getVendorName(fabric.rootVendorId)} (0x${fabric.rootVendorId.toString(16).toUpperCase().padStart(4, "0")})`}
      arrow
    >
      <Box
        component="span"
        sx={{ fill: (theme) => theme.palette.text.primary }}
      >
        {BrandIcon ? (
          <BrandIcon
            style={{
              height: "1.4em",
              width: "auto",
              maxWidth: "3em",
              display: "block",
            }}
          />
        ) : (
          <QuestionMark />
        )}
      </Box>
    </Tooltip>
  );
};
