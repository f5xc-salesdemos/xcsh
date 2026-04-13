import { ProfileService } from "./f5xc-profile";

export interface RenderedSegment {
	content: string;
	visible: boolean;
}

export function renderF5XCProfileSegment(): RenderedSegment {
	try {
		const service = ProfileService.instance;
		const status = service.getStatus();

		if (!status.isConfigured) {
			return { content: "", visible: false };
		}

		// For env-backed sessions (no profile name), show tenant:namespace from env vars
		const label = status.activeProfileTenant ?? status.activeProfileName ?? "env";
		return { content: `${label}:${status.activeProfileNamespace ?? "default"}`, visible: true };
	} catch {
		// ProfileService not initialized — silently hide segment
		return { content: "", visible: false };
	}
}
