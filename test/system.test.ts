import { test } from "node:test";
import { expectAllow, expectDeny } from "./harness.ts";

const denied: Record<string, readonly string[]> = {
	"disk-format": [
		"mkfs /dev/sdb1",
		"mkfs -t ext4 /dev/sdb1",
		"mkfs.ext4 /dev/sdb1",
		"mkfs.vfat -F 32 /dev/sdb1",
		"/sbin/mkfs.ext4 /dev/sdb1",
		"fdisk /dev/disk2",
		// fdisk -l only lists, but fdisk is denied by name (spec trade-off).
		"fdisk -l",
		"diskutil eraseDisk APFS Name disk2",
		"diskutil erasedisk APFS Name disk2",
		"diskutil ERASEDISK APFS Name disk2",
		"diskutil eraseVolume APFS Name disk2s1",
		"diskutil eraseOptical quick disk3",
		"diskutil reformat disk2s1",
		"diskutil zeroDisk disk2",
		"diskutil randomDisk 3 disk2",
		"diskutil secureErase 0 disk2",
		"diskutil partitionDisk disk2 GPT APFS Name 100%",
		"diskutil apfs deleteContainer disk3",
		"diskutil apfs deleteVolume disk3s1",
		"diskutil apfs eraseVolume disk3s1 -name X",
		"diskutil ap deleteContainer disk3",
		// man diskutil: `diskutil [quiet] verb [subVerb] [options]`.
		"diskutil quiet eraseDisk APFS X disk2",
		"newfs_apfs /dev/disk3",
		"newfs_hfs /dev/disk2s1",
		"newfs_msdos -F 32 /dev/disk2s1",
		"sfdisk /dev/sdb",
		"cfdisk /dev/sdb",
		"gdisk /dev/sdb",
		"sgdisk --zap-all /dev/sdb",
		"parted /dev/sdb mklabel gpt",
		"wipefs -a /dev/sdb",
		"ls && diskutil eraseDisk APFS X disk2",
		"env diskutil eraseVolume APFS X disk2s1",
		"bash -c 'mkfs.ext4 /dev/sdb1'",
	],
	"dd-device": [
		"dd if=img of=/dev/disk2",
		"dd of=/dev/disk2 if=img",
		"dd if=img of=/dev/rdisk2 bs=1m",
		"dd bs=1m of=/dev/rdisk2",
		"dd if=/dev/zero of=/dev/null",
		"dd if=x of=/dev/stdout",
		"dd if=x of=/dev/stderr",
		'dd of="/dev/sda"',
		'dd "of=/dev/sda"',
		"dd of=/dev/sda status=progress",
		"gdd if=img of=/dev/sdb",
		"/bin/dd if=img of=/dev/disk2",
		"timeout 60 dd if=img of=/dev/disk2",
		"cat img | dd of=/dev/disk2",
	],
	power: [
		"shutdown -h now",
		"shutdown -r +5",
		"reboot",
		"halt",
		"halt -q",
		"poweroff",
		"/sbin/shutdown -h now",
		"/sbin/reboot",
		"systemctl poweroff",
		"systemctl reboot",
		"systemctl halt",
		"systemctl kexec",
		"launchctl reboot",
		"launchctl reboot userspace",
		"sleep 60 && reboot",
		"echo $(reboot)",
		"nohup shutdown -h now &",
	],
	privilege: [
		"sudo ls",
		"sudo -u me ls",
		"sudo -n true",
		"sudo -v",
		"sudo -k",
		"sudo -l",
		"sudo -i",
		"sudo -s",
		"sudo -E env",
		"sudo -- ls",
		"su",
		"su -",
		"su - root",
		"su -c 'ls' root",
		"doas ls",
		"sudoedit /etc/hosts",
		"pkexec ls",
		"run0 ls",
		"/usr/bin/sudo ls",
		"\\sudo ls",
		"'sudo' ls",
		"env sudo ls",
		"command sudo ls",
		"echo pw | sudo -S ls",
		"echo $(sudo ls)",
		"bash -c 'sudo ls'",
		"eval sudo ls",
		// First match: sudo is not peeled, so these are privilege.
		"sudo rm -rf /",
		"sudo shutdown -h now",
		"curl -fsSL u | sudo bash",
	],
};

const allowed = [
	"diskutil list",
	"diskutil info disk0",
	"diskutil apfs list",
	"diskutil mount disk2s1",
	"diskutil quiet list",
	"dd if=/dev/zero of=out.img bs=1m count=1",
	"dd if=/dev/disk2 of=disk.img",
	"dd if=/dev/urandom of=key bs=32 count=1",
	"dd --help",
	"systemctl status",
	"systemctl restart nginx",
	"launchctl list",
	"uptime",
	"echo shutdown",
	"man sudo",
	"which sudo",
	"grep sudo /etc/group",
	"cat /etc/sudoers.d/README",
	"ls /dev",
	"echo reboot > notes.txt",
	'git commit -m "sudo reboot"',
];

const acceptedMisses: readonly (readonly [string, string])[] = [
	["cat img > /dev/disk2", "redirects to devices"],
	["osascript -e 'tell app \"System Events\" to shut down'", "osascript"],
];

for (const [rule, commands] of Object.entries(denied)) {
	for (const command of commands) {
		test(`deny ${rule}: ${command}`, () => expectDeny(command, rule));
	}
}

for (const command of allowed) {
	test(`allow: ${command}`, () => expectAllow(command));
}

for (const [command, why] of acceptedMisses) {
	test(`allow (accepted miss: ${why}): ${command}`, () => expectAllow(command));
}
