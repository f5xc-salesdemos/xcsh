/**
 * Minimal SDK Usage
 *
 * Uses all defaults: discovers skills, hooks, tools, context files
 * from cwd and ~/.xcsh/agent. Model chosen from settings or first available.
 */
import { createAgentSession } from "@f5xc-salesdemos/xcsh";

const { session } = await createAgentSession();

session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("What files are in the current directory?");
session.state.messages.forEach(msg => {
	console.log(msg);
});
console.log();
