import { ProfileService } from "./f5xc-profile";

export interface RenderedSegment {
	content: string;
	visible: boolean;
}

export function renderF5XCProfileSegment(): RenderedSegment {
	try {
		const service = ProfileService.instance;
		const status = service.getStatus();

		if (!status.isConfigured || !status.activeProfileName) {
			return { content: "", visible: false };
		}

		return { content: `${status.activeProfileTenant ?? status.activeProfileName}:${status.activeProfileNamespace ?? "default"}`, visible: true };
	} catch {
		// ProfileService not initialized — silently hide segment
		return { content: "", visible: false };
	}
}
