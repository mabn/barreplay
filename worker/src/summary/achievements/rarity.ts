// How RARE each achievement is, 1 (common) to 5 (legendary). Each knob was
// tuned over 732 lava games since 2026-09-05 (worker/tools/achievement-rates.ts)
// so that, per game, the commons hand out about 24 awards between them,
// uncommons 12, rares 6, epics 1 and legendaries 0.5 (Marcin's budget,
// shared evenly by each tier's members). Rules with no knob, or one that
// cannot reach its share, sit in the tier nearest how often they fire. A rule that states
// its own `rarity` (a tier, or one picked by hand) wins over this table.
import { type Rule } from "./rulekit";

export const MEASURED_GAMES = 732;

export const RARITY: Record<number, number> = {
  50: 4, 153: 4, 208: 1, 224: 1, 267: 1, 291: 5, 434: 2, 450: 5, 562: 2, 570: 5, 598: 5, 613: 5,
  653: 5, 661: 5, 671: 4, 677: 2, 701: 5, 703: 4, 720: 5, 723: 3, 725: 2, 730: 5, 754: 5, 775: 5,
  785: 4, 786: 3, 787: 4, 821: 5, 825: 3, 880: 5, 896: 3, 1031: 3, 1103: 5, 1122: 5, 1135: 5, 1137: 5,
  1153: 4, 1154: 5, 1158: 3, 1187: 3, 1206: 5, 1222: 5, 1224: 5, 1232: 3, 1250: 1, 1268: 2, 1283: 5, 1291: 4,
  1292: 3, 1302: 1, 1308: 1, 1317: 4, 1351: 5, 1358: 2, 1370: 1, 1391: 1, 1405: 2, 1465: 3, 1480: 3, 1490: 1,
  1493: 5, 1494: 1, 1497: 3, 1519: 5, 1524: 1, 1532: 5, 1536: 1, 1551: 3, 1565: 3, 1576: 2, 1596: 5, 1597: 2,
  1618: 1, 1644: 2, 1645: 1, 1646: 3, 1647: 1, 1648: 1, 1649: 1, 1650: 5, 1651: 1, 1653: 1, 1654: 5, 1655: 3,
  1656: 1, 1657: 4, 1659: 1, 1660: 4, 1661: 3, 1662: 1, 1664: 1, 1665: 1, 1666: 4, 1667: 3, 1668: 4, 1669: 5,
  1670: 4, 1671: 1, 1672: 4, 1673: 3, 1674: 4, 1675: 1, 1676: 2, 1677: 1, 1678: 4, 1679: 5, 1680: 5, 1683: 3,
  1684: 5, 1685: 1, 1686: 5, 1687: 1, 1688: 2, 1689: 5, 1690: 4, 1691: 3, 1692: 5, 1693: 5, 1694: 1, 1695: 1,
  1696: 4, 1697: 1, 1698: 1, 1699: 1, 1700: 3, 1701: 1, 1702: 1, 1703: 2, 1704: 2, 1705: 3, 1706: 1, 1708: 5,
  1709: 2, 1710: 1, 1711: 1, 1712: 1, 1713: 3, 1714: 5, 1715: 1, 1716: 3, 1717: 4, 1719: 1, 1720: 5, 1721: 1,
  1722: 1, 1723: 5, 1724: 5, 1725: 5, 1726: 3, 1727: 2, 1728: 3, 1729: 2, 1730: 5, 1731: 2, 1732: 4, 1734: 3,
  1735: 2, 1736: 1, 1737: 1, 1738: 1, 1739: 1, 1740: 1, 1741: 2, 1742: 5, 1743: 1, 1744: 1, 1745: 5, 1748: 3,
  1749: 1, 1750: 1, 1751: 1, 1753: 1, 1754: 5, 1756: 4, 1757: 1, 1760: 1, 1761: 3, 1762: 3, 1763: 3, 1764: 3,
  1765: 1, 1766: 5, 1767: 5, 1768: 5, 1769: 5, 1770: 2, 1771: 3, 1772: 1, 1775: 5, 1777: 4, 1778: 5, 1780: 1,
  1783: 5, 1784: 4, 1785: 5, 1787: 2, 1788: 5, 1789: 4, 1790: 5, 1791: 4, 1792: 3, 1793: 5, 1794: 5, 1795: 5,
  1796: 2, 1797: 5, 1798: 5, 1799: 5, 1800: 5, 1868: 4, 1869: 5, 1870: 3, 1871: 3, 1872: 3, 1873: 5, 1874: 2,
  1875: 4, 1876: 5, 1877: 2, 1878: 1, 1879: 1, 1880: 5, 1881: 1, 1882: 1, 1883: 3, 1884: 1, 1886: 1, 1887: 1,
};

export const RARITY_NAMES = ["", "common", "uncommon", "rare", "epic", "legendary"];

/** rarityOf is a rule's rarity: its own, else the measured one, else rare. */
export function rarityOf(r: Rule): number {
  return r.rarity ?? RARITY[r.id] ?? 3;
}

/** rarityWhy says where rarityOf's answer comes from. */
export function rarityWhy(r: Rule): string {
  if (r.rarity) return "set by hand";
  if (RARITY[r.id]) return `tuned over ${MEASURED_GAMES} lava games`;
  return "not measured yet";
}
