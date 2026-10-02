import { test } from "node:test";
import { expectAllow, expectDeny } from "../../test/harness.ts";

const denied = [
	"pi --yolo",
	"pi -p hi --yolo",
	"pi --yolo=on",
	"/opt/homebrew/bin/pi --yolo",
	"nohup pi --yolo &",
	"sh -c 'pi --yolo'",
	"PI_BOUNCER_AGENT=w pi",
	"PI_SUBAGENT_AGENT=w pi -p hi",
	"PI_DADDY_DEFINITION=w pi",
	"env PI_BOUNCER_AGENT=w pi",
	"env -i PI_BOUNCER_AGENT=w pi",
	"export PI_BOUNCER_AGENT=w",
	"export PI_BOUNCER_AGENT",
	"declare -x PI_SUBAGENT_AGENT=w",
	"typeset PI_BOUNCER_AGENT=w",
	"readonly PI_BOUNCER_AGENT=w",
	"local PI_BOUNCER_AGENT=w",
	"PI_BOUNCER_AGENT=w",
	"cd x && PI_BOUNCER_AGENT=w pi",
	'echo "$(PI_BOUNCER_AGENT=w pi -p hi)"',
	"sh -c 'PI_BOUNCER_AGENT=w pi'",
	"nohup env PI_BOUNCER_AGENT=w pi",
	"unset PI_BOUNCER_AGENT; pi",
	"unset -v PI_DADDY_DEFINITION",
	"env -u PI_SUBAGENT_AGENT pi",
	"env -uPI_SUBAGENT_AGENT pi",
	"env --unset=PI_SUBAGENT_AGENT pi",
	"env --unset PI_SUBAGENT_AGENT pi",
	"env -i pi",
	"env - pi -p hi",
	"env -i /opt/homebrew/bin/pi",
];

const allowed = [
	"pi",
	'pi -p "try pi --yolo"',
	"pi -- --yolo",
	"pi --auto",
	'git commit -m "pi --yolo"',
	"echo PI_BOUNCER_AGENT=w",
	'echo "$PI_BOUNCER_AGENT"',
	"printenv PI_BOUNCER_AGENT",
	"rg PI_BOUNCER_AGENT src",
	"PI_OTHER=1 pi",
	"export FOO=1",
	"env FOO=1 pi",
	"unset FOO",
	"env -u FOO pi",
	"env -i ls",
	"echo unset PI_BOUNCER_AGENT",
];

for (const command of denied) {
	test(`deny bouncer-escape: ${command}`, async () => {
		await expectDeny(command, "bouncer-escape");
	});
}

for (const command of allowed) {
	test(`allow: ${command}`, async () => {
		await expectAllow(command);
	});
}
