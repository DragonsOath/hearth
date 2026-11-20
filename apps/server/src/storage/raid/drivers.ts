import type { RaidDriver } from "./driver";
import { btrfsDriver } from "./btrfs";
import { drivepoolDriver } from "./drivepool";
import { snapraidDriver } from "./snapraid";
import { spacesDriver } from "./spaces";
import { zfsDriver } from "./zfs";

/** Every technology besides Linux software RAID, in the order the tab lists them. */
export const DRIVERS: RaidDriver[] = [
  zfsDriver,
  btrfsDriver,
  spacesDriver,
  snapraidDriver,
  drivepoolDriver,
];
