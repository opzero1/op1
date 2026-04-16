import { loadFastModeConfig } from "../config.js";
import {
	type FastModeModelTarget,
	loadFastModeState,
	saveFastModeState,
	setModelFastModeEnabled,
} from "../state.js";
import {
	buildFastModeDialogOptions,
	formatFastModeDialogTitle,
} from "./options.js";
import type { TuiPluginApi } from "./types.js";

const ROUTE_NAME = "fast-mode";
const COMMAND_VALUE = "fast-mode.toggle";

function getRouteSessionID(api: TuiPluginApi): string | undefined {
	const sessionID = api.route.current.params?.sessionID;
	return typeof sessionID === "string" && sessionID.length > 0
		? sessionID
		: undefined;
}

function navigateBack(api: TuiPluginApi): void {
	const sessionID = getRouteSessionID(api);
	if (sessionID) {
		api.route.navigate("session", { sessionID });
		return;
	}

	api.route.navigate("home");
}

async function toggleModel(api: TuiPluginApi, target: FastModeModelTarget) {
	const directory = api.state.path.directory;
	if (!directory) {
		api.ui.toast({
			variant: "warning",
			message: "Workspace directory not available yet.",
		});
		return;
	}

	const currentState = await loadFastModeState(directory);
	const enabled =
		currentState.providers[target.providerID]?.models[target.modelID] === true;
	const nextState = setModelFastModeEnabled(
		currentState,
		target.providerID,
		target.modelID,
		!enabled,
	);
	await saveFastModeState(directory, nextState);

	api.ui.toast({
		variant: "success",
		message: `${target.providerID}/${target.modelID} fast mode ${enabled ? "OFF" : "ON"}`,
	});

	await showFastModeDialog(api);
}

async function showFastModeDialog(api: TuiPluginApi): Promise<void> {
	const directory = api.state.path.directory;
	if (!directory) {
		if (api.route.current.name === ROUTE_NAME) {
			navigateBack(api);
		}
		api.ui.toast({
			variant: "warning",
			message: "Workspace directory not available yet.",
		});
		return;
	}

	const [config, state] = await Promise.all([
		loadFastModeConfig(directory),
		loadFastModeState(directory),
	]);

	const options = buildFastModeDialogOptions({
		config,
		state,
		onSelect: (target) => {
			void toggleModel(api, target);
		},
	});

	api.ui.dialog.replace(
		() =>
			api.ui.DialogSelect({
				title: formatFastModeDialogTitle(config, state),
				placeholder: "Toggle fast mode for configured provider/model pairs…",
				options,
			}),
		() => {
			if (api.route.current.name === ROUTE_NAME) {
				navigateBack(api);
			}
		},
	);
}

export async function installFastModePlugin(api: TuiPluginApi): Promise<void> {
	api.route.register([
		{
			name: ROUTE_NAME,
			render: () => {
				Promise.resolve().then(() => showFastModeDialog(api));
				return null;
			},
		},
	]);

	api.command.register(() => [
		{
			title: "Fast Mode",
			value: COMMAND_VALUE,
			description: "Toggle fast mode for configured models",
			category: "Fast Mode",
			onSelect: () => {
				const sessionID =
					api.route.current.name === "session"
						? (getRouteSessionID(api) ?? api.route.current.params?.sessionID)
						: undefined;
				api.route.navigate(ROUTE_NAME, sessionID ? { sessionID } : undefined);
			},
		},
	]);
}
