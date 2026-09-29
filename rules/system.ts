// Formatting disks, writing raw bytes to devices, and taking the machine down.
import type { Invocation } from "../scan/walk.ts";
import type { Rule } from "./rule.ts";

// Partitioning and wiping tools, denied by name. `fdisk -l` only lists, but
// the spec denies fdisk by name.
const DISK_TOOLS: ReadonlySet<string> = new Set([
	"mkfs",
	"fdisk",
	"sfdisk",
	"cfdisk",
	"gdisk",
	"sgdisk",
	"parted",
	"wipefs",
]);

// diskutil verbs that erase or repartition (`man diskutil`), lower-cased:
// diskutil matches verbs without case, and denying more is the safe side.
const DISKUTIL_VERBS: ReadonlySet<string> = new Set([
	"reformat",
	"zerodisk",
	"randomdisk",
	"secureerase",
	"partitiondisk",
]);

/** `diskutil [quiet] verb [subVerb] …` (man diskutil). */
function diskutilErases(args: readonly string[]): boolean {
	const [verb = "", subVerb = ""] = (
		args[0]?.toLowerCase() === "quiet" ? args.slice(1) : args
	).map((arg) => arg.toLowerCase());
	if (verb.startsWith("erase") || DISKUTIL_VERBS.has(verb)) return true;
	return (
		(verb === "apfs" || verb === "ap") &&
		(subVerb.startsWith("erase") || subVerb.startsWith("delete"))
	);
}

export const diskFormat: Rule = {
	name: "disk-format",
	summary: "formatting, erasing or repartitioning a disk destroys its data",
	matches: ({ name, args }: Invocation): boolean =>
		DISK_TOOLS.has(name) ||
		name.startsWith("mkfs.") ||
		name.startsWith("newfs_") ||
		(name === "diskutil" && diskutilErases(args)),
};

// `gdd` is GNU dd from Homebrew coreutils.
const DD_NAMES: ReadonlySet<string> = new Set(["dd", "gdd"]);

export const ddDevice: Rule = {
	name: "dd-device",
	summary: "dd writing to a /dev path overwrites a raw device",
	matches: ({ name, args }: Invocation): boolean =>
		DD_NAMES.has(name) && args.some((arg) => arg.startsWith("of=/dev/")),
};

const POWER_NAMES: ReadonlySet<string> = new Set([
	"shutdown",
	"reboot",
	"halt",
	"poweroff",
]);
const SYSTEMCTL_POWER: ReadonlySet<string> = new Set([
	"poweroff",
	"reboot",
	"halt",
	"kexec",
]);

export const power: Rule = {
	name: "power",
	summary: "shutting down or rebooting takes the user's machine down",
	matches: ({ name, args }: Invocation): boolean =>
		POWER_NAMES.has(name) ||
		(name === "systemctl" && args.some((arg) => SYSTEMCTL_POWER.has(arg))) ||
		(name === "launchctl" && args[0] === "reboot"),
};
