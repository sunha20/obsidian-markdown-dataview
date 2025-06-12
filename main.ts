import {
	App,
	debounce,
	normalizePath,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	TextComponent,
	ToggleComponent
} from "obsidian";

enum FolderNoteType {
	InsideFolder = "INSIDE_FOLDER",
	// OutsideFolder = "OUTSIDE_FOLDER",
}

enum WaypointType {
	Waypoint = "waypoint",
	Landmark = "landmark",
}

interface WaypointSettings {
	waypointFlag: string;
	landmarkFlag: string;
	stopScanAtFolderNotes: boolean;
	showFolderNotes: boolean;
	showNonMarkdownFiles: boolean;
	debugLogging: boolean;
	useWikiLinks: boolean;
	useFrontMatterTitle: boolean;
	showEnclosingNote: boolean;
	folderNoteType: string;
	folderNoteName: string;
	ignorePaths: string[];
	useSpaces: boolean;
	numSpaces: number;
}

const DEFAULT_SETTINGS: WaypointSettings = {
	waypointFlag: "%% Waypoint %%",
	landmarkFlag: "%% Landmark %%",
	stopScanAtFolderNotes: false,
	showFolderNotes: false,
	showNonMarkdownFiles: false,
	debugLogging: false,
	useWikiLinks: true,
	useFrontMatterTitle: false,
	showEnclosingNote: false,
	folderNoteType: FolderNoteType.InsideFolder,
	folderNoteName: "",
	ignorePaths: ["_attachments"],
	useSpaces: false,
	numSpaces: 2
};

export default class Waypoint extends Plugin {
	static readonly BEGIN_WAYPOINT = "%% Begin Waypoint %%";
	static readonly END_WAYPOINT = "%% End Waypoint %%";
	static readonly BEGIN_LANDMARK = "%% Begin Landmark %%";
	static readonly END_LANDMARK = "%% End Landmark %%";

	foldersWithChanges = new Set<TFolder>();
	settings: WaypointSettings;

	async onload() {
		await this.loadSettings();
		this.addCommand({
			id: "go_to_parent_waypoint",
			name: "Go to parent Waypoint",
			callback: async () => {
				const curFile = this.app.workspace.getActiveFile();
				const [, parentPoint] = await this.locateParentPoint(curFile, false);
				this.app.workspace.activeLeaf.openFile(parentPoint);
			}
		});
		this.app.workspace.onLayoutReady(async () => {
			// Register events after layout is built to avoid initial wave of 'create' events
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					this.log("create " + file.name);
					this.foldersWithChanges.add(file.parent);
					this.scheduleUpdate();
				})
			);
			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					this.log("delete " + file.name);
					const parentFolder = this.getParentFolder(file.path);
					if (parentFolder !== null) {
						this.foldersWithChanges.add(parentFolder);
						this.scheduleUpdate();
					}
				})
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					this.log("rename " + file.name);
					this.foldersWithChanges.add(file.parent);
					const parentFolder = this.getParentFolder(oldPath);
					if (parentFolder !== null) {
						this.foldersWithChanges.add(parentFolder);
					}
					this.scheduleUpdate();
				})
			);
			this.registerEvent(this.app.vault.on("modify", this.detectFlags));
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new WaypointSettingsTab(this.app, this));
	}

	onunload() {
	}

	detectFlags = async (file: TFile) => {
		this.detectFlag(file, WaypointType.Waypoint);
		this.detectFlag(file, WaypointType.Landmark);
	};

	/**
	 * Scan the given file for the waypoint flag. If found, update the waypoint.
	 * @param file The file to scan
	 */
	detectFlag = async (file: TFile, flagType: WaypointType) => {
		this.log("Modification on " + file.name);
		this.log("Scanning for " + flagType + " flags...");
		const waypointFlag = await this.getWaypointFlag(flagType);
		const text = await this.app.vault.cachedRead(file);
		const lines: string[] = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim().includes(waypointFlag)) {
				if (this.isFolderNote(file)) {
					this.log("Found " + flagType + " flag in folder note!");
					await this.updateWaypoint(file, flagType);
					await this.updateParentPoint(file.parent, this.settings.folderNoteType === FolderNoteType.OutsideFolder);
					return;
				} else if (file.parent.isRoot()) {
					this.log("Found " + flagType + " flag in root folder.");
					this.printError(file, `%% Error: Cannot create a ` + flagType + ` in the root folder of your vault. For more information, check the instructions [here](https://github.com/IdreesInc/Waypoint) %%`, flagType);
					return;
				} else {
					this.log("Found " + flagType + " flag in invalid note.");
					this.printError(file, `%% Error: Cannot create a ` + flagType + ` in a note that's not the folder note. For more information, check the instructions [here](https://github.com/IdreesInc/Waypoint) %%`, flagType);
					return;
				}
			}
		}
		this.log("No " + flagType + " flags found.");
	};

	isFolderNote(file: TFile): boolean {
		if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
			if (this.settings.folderNoteName == "") {
				return file.basename == file.parent.name;
			} else {
				return file.basename == this.settings.folderNoteName;
			}
		}
		if (file.parent) {
			return this.app.vault.getAbstractFileByPath(this.getCleanParentPath(file) + file.basename) instanceof TFolder;
		}
		return false;
	}

	getCleanParentPath(node: TAbstractFile): string {
		if (node.parent instanceof TFolder && node.parent.isRoot()) {
			return "";
		}
		return node.parent.path + "/";
	}

	async printError(file: TFile, error: string, flagType: WaypointType) {
		this.log("Creating " + flagType + " error in " + file.path);
		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n");
		let waypointIndex = -1;
		const pointFlag = await this.getWaypointFlag(flagType);
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.includes(pointFlag)) {
				waypointIndex = i;
			}
		}
		if (waypointIndex === -1) {
			console.error("Error: No " + flagType + " flag found while trying to print error.");
			return;
		}
		lines.splice(waypointIndex, 1, error);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/**
	 * Get the string indices of the begin and end points for the given waypoint.
	 */
	async getWaypointBounds(flag: string): Promise<[string, string] | [null, null]> {
		if (flag === WaypointType.Waypoint) {
			return [Waypoint.BEGIN_WAYPOINT, Waypoint.END_WAYPOINT];
		}
		if (flag === WaypointType.Landmark) {
			return [Waypoint.BEGIN_LANDMARK, Waypoint.END_LANDMARK];
		}
		return [null, null];
	}

	/**
	 * Get the indicator for the given waypoint type.
	 */
	async getWaypointFlag(type: WaypointType): Promise<string> | null {
		if (type === WaypointType.Waypoint) {
			return this.settings.waypointFlag;
		} else if (type === WaypointType.Landmark) {
			return this.settings.landmarkFlag;
		}
		console.error("Error: Invalid waypoint type: " + type);
		return null;
	}

	/**
	 * Given a file with a waypoint flag, generate a file tree representation and update the waypoint text.
	 * @param file The file to update
	 */
	async updateWaypoint(file: TFile, flagType: WaypointType) {
		this.log("Updating " + flagType + " in " + file.path);
		let fileTree;
		if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
			fileTree = await this.getFileTreeRepresentation(file.parent, file.parent, 0, true);
		} else {
			const folder = this.app.vault.getAbstractFileByPath(this.getCleanParentPath(file) + file.basename);
			if (folder instanceof TFolder) {
				fileTree = await this.getFileTreeRepresentation(file.parent, folder, 0, true);
			}
		}
		const [beginWaypoint, endWaypoint] = await this.getWaypointBounds(flagType);
		let waypoint = `${beginWaypoint}\n${fileTree}\n\n${endWaypoint}`;
		if (beginWaypoint === null || endWaypoint === null) {
			console.error("Error: Waypoint bounds not found, unable to continue.");
			return;
		}
		const waypointFlag = await this.getWaypointFlag(flagType);
		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n");
		let waypointStart = -1;
		let waypointEnd = -1;
		let isCallout;
		// Whether this is the first time we are creating the waypoint
		let initialWaypoint = false;
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (waypointStart === -1 && (trimmed.includes(waypointFlag) || trimmed.includes(beginWaypoint))) {
				isCallout = trimmed.startsWith(">");
				initialWaypoint = trimmed.includes(waypointFlag);
				waypointStart = i;
				continue;
			}
			if (waypointStart !== -1 && trimmed === endWaypoint) {
				waypointEnd = i;
				break;
			}
		}
		if (waypointStart === -1) {
			console.error("Error: No " + flagType + " found while trying to update " + file.path);
			return;
		}
		this.log(flagType + " found at " + waypointStart + " to " + waypointEnd);
		if (isCallout) {
			if (initialWaypoint) {
				// Add callout block prefix to the waypoint
				const prefix = flagType === WaypointType.Landmark ? "[!landmark]\n" : "[!waypoint]\n";
				waypoint = prefix + waypoint;
			}
			// Prefix each line with ">" to make it a callout
			const waypointLines = waypoint.split("\n");
			const updatedLines = waypointLines.map((line) => `>${line}`);
			waypoint = updatedLines.join("\n");
		}
		lines.splice(waypointStart, waypointEnd !== -1 ? waypointEnd - waypointStart + 1 : 1, waypoint);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/**
	 * Generate a file tree representation as a Markdown table of the given folder.
	 * @param rootNode The root of the file tree that will be generated
	 * @param node The current node in our recursive descent
	 * @param indentLevel How many levels of indentation to draw (used internally)
	 * @param topLevel Whether this is the top level of the tree or not
	 * @returns The string representation of the tree, or null if the node is not a file or folder
	 */
	async getFileTreeRepresentation(rootNode: TFolder, node: TAbstractFile,	indentLevel: number, topLevel = false): Promise<string | null> {
		// [변경] indent 및 bullet(트리용)은 사용하지 않음
		if (!(node instanceof TFile) && !(node instanceof TFolder)) return null;

		this.log(node.path);
		if (this.ignorePath(node.path)) return null;

		// // [변경] 파일일 경우 row로만 처리
		// if (node instanceof TFile) {
		// 	if (this.settings.debugLogging) {
		// 		console.log(node);
		// 	}
		// 	let title: string | null = null;
		// 	if (this.settings.useFrontMatterTitle) {
		// 		const fm = this.app.metadataCache?.getFileCache(node)?.frontmatter;
		// 		if (fm && fm.hasOwnProperty("title")) {
		// 			title = fm.title;
		// 		}
		// 	}
		//
		// 	// [변경] Table row로 반환, wiki link 또는 markdown link 지원
		// 	if (node.extension == "md") {
		// 		if (this.settings.useWikiLinks) {
		// 			return title
		// 				? `|[[${node.basename}|${title}]]|`
		// 				: `|[[${node.basename}]]|`;
		// 		} else {
		// 			return title
		// 				? `|[${title}](${this.getEncodedUri(rootNode, node)})|`
		// 				: `|[${node.basename}](${this.getEncodedUri(rootNode, node)})|`;
		// 		}
		// 	}
		// 	// Non-markdown files
		// 	if (this.settings.showNonMarkdownFiles) {
		// 		if (this.settings.useWikiLinks) {
		// 			return `|[[${node.name}]]|`;
		// 		}
		// 		return `|[${node.name}](${this.getEncodedUri(rootNode, node)})|`;
		// 	}
		// 	return null;
		// }

		// // [변경] 폴더 - 폴더 노트 경로 계산
		// let folderNote: TFile | null = null;
		// if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
		// 	const note = this.app.vault.getAbstractFileByPath(
		// 		node.path + "/" + node.name + ".md"
		// 	);
		// 	folderNote = note instanceof TFile ? note : null;
		// } else if (node.parent) {
		// 	const note = this.app.vault.getAbstractFileByPath(
		// 		node.parent.path + "/" + node.name + ".md"
		// 	);
		// 	folderNote = note instanceof TFile ? note : null;
		// }

		// [변경] 자식 요소 처리(정렬/필터)
		let children = node.children ? [...node.children] : [];
		children = children.sort((a, b) => {
			// 기본: 생성일(ctime) 기준 내림차순, 없으면 이름순
			if (!a.stat?.ctime) return -1;
			if (!b.stat?.ctime) return 1;
			return new Date(b.stat.ctime).getTime() - new Date(a.stat.ctime).getTime();
		});

		// 폴더노트 숨김/필터링
		const filtered: TAbstractFile[] = [];
		let folderNote:TFile;
		for (const child of children) {
			// TFile이면서 폴더노트라면 건너뛰고, 아니면 배열에 추가
			if (this.ignorePath(child.path)) {
				continue
			}

			if (child instanceof TFile && this.isFolderNote(child)) {
				folderNote = child
				if (!this.settings.showFolderNotes) {
					continue
				}
			}

			filtered.push(child);
		}
		children = filtered;

		let out = `# ${rootNode.name}`
		// [변경] 폴더 내 new file/new folder 버튼
		if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
			if (this.settings.useWikiLinks) {
				out +=
					`\n[[${node.path}/new file.md\\|new file]] | [[${node.path}/new folder/new folder.md\\|new folder]]\n`;
			} else {
				out += `\n[new file](${node.path}/new file.md) | [new folder](${node.path}/new folder/README.md)\n`;

			}
		} else if (node.parent) {
			out +=
				`\n[[${node.path}/new file.md\\|new file]]\n`;
		}

		// [변경] Table head: frontmatter keys 추출 (동적 column)
		const frontmatter =
			this.app.metadataCache?.getFileCache(folderNote ?? node as TFile)?.frontmatter;
		let keyList = ["TITLE", "DATE"];
		let dash = ["---", "---"];
		if (
			frontmatter != null &&
			frontmatter.hasOwnProperty("keys") &&
			Array.isArray(frontmatter.keys)
		) {
			for (const key of frontmatter.keys) {
				keyList.push(key);
				dash.push("---");
			}
		}

		out += "\n|" + keyList.join("|") + "|\n|" + dash.join("|") + "|\n";

		// [변경] 각 자식 노드를 Table Row로 추가 (재귀 x)
		for (const child of children) {
			let row = "";
			let name: string = "";
			let alias: string | null = null;
			let ctime: number | string | undefined;
			let f =
				child instanceof TFile
					? this.app.metadataCache?.getFileCache(child)?.frontmatter
					: undefined;

			for (const key of keyList) {
				switch (key) {
					case "TITLE":
					case "Title":
					case "title":
						if (child instanceof TFile) {
							name = child.extension == "md" ? child.basename : child.name;
							if (this.settings.useFrontMatterTitle) {
								if (f && f.hasOwnProperty("title")) name = f.title;
							}
							if (this.settings.useWikiLinks) {
								row += `|[[${child.path}\\|${name}]]`;
							} else {
								row += `|[${name}](${child.path.replaceAll(" ", "%20")})`;
							}
						} else if (child instanceof TFolder) {
							let path: string;
							if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
								if (this.settings.folderNoteName == "") {
									path = child.path + "/" + child.name + ".md";
								} else {
									path = child.path + "/" + this.settings.folderNoteName + ".md";
								}
							} else if (node.parent) {
								if (this.settings.folderNoteName == "") {
									path = child.path + "/" + child.name + ".md";
								} else {
									path = child.path + "/" + this.settings.folderNoteName + ".md";
								}
							} else {
								path = "";
							}
							if (this.settings.useWikiLinks) {
								row += `|[[${path}\\|${child.name}]]`;
							} else {
								row += `|[${child.name}](${path.replaceAll(" ", "%20")})`;
							}
						}
						break;

					case "DATE":
					case "Date":
					case "date":
						if (child instanceof TFile) {
							if (f?.DATE) ctime = f.DATE;
							else if (f?.Date) ctime = f.Date;
							else if (f?.date) ctime = f.date;
							else ctime = child.stat?.ctime;
							let date = new Date(ctime ?? "");
							row += `|${date.getFullYear()}-${this.addZero(
								date.getMonth() + 1
							)}-${this.addZero(date.getDate())} (${this.convertDay(date.getDay())})`;
						} else {
							row += "|";
						}
						break;

					case "tags":
						if (f && f.hasOwnProperty(key)) {
							let val = f[key];
							if (Array.isArray(val)) val = val.join(" ");
							row += `|${val}`;
						} else row += "|";
						break;

					default:
						if (f && f.hasOwnProperty(key)) {
							let val = f[key];
							// array인 경우
							if (Array.isArray(val)) {
								val = val.map((v: string) => this.convertLink(v, key)).join(", ");
							} else {
								val = this.convertLink(val, key);
							}
							if (val === null) val = "";
							if (val === undefined) val = "b";
							row += `|${val}`;
						} else {
							row += "|";
						}
						break;
				}
			}
			row += "|\n";
			out += row;
		}

		return out;
	}
	convertDay(dt: number): string {
		switch (dt) {
			case 0: return "일";
			case 1: return "월";
			case 2: return "화";
			case 3: return "수";
			case 4: return "목";
			case 5: return "금";
			case 6: return "토";
			default: return ""; // 예외 처리
		}
	}

	addZero(dt: number): string {
		const dtStr = dt.toString();
		if (dtStr.length === 1) {
			return "0" + dtStr;
		} else {
			return dtStr;
		}
	}

	convertLink(v: any, k: string): string {
		if (typeof v === "string" && v.length > 12) {
			if (v === "[[") return "";
			if (v === null) return "";
			if (v.startsWith("[[")) return v.replace("]]", `\\|${k}]]`);
			if (v.startsWith("https://") || v.startsWith("http://")) return `[${k}](${v})`;
			return v;
		}
		return String(v); // 숫자, null 등도 string으로 반환
	}



	/**
	 * Generate an encoded URI path to the given file that is relative to the given root.
	 * @param rootNode The from which the relative path will be generated
	 * @param node The node to which the path will be generated
	 * @returns The encoded path
	 */
	getEncodedUri(rootNode: TFolder, node: TAbstractFile) {
		if (rootNode.isRoot()) {
			return `./${encodeURI(node.path)}`;
		}
		return `./${encodeURI(node.path.substring(rootNode.path.length + 1))}`;
	}

	ignorePath(path: string): boolean {
		let found = false;
		this.settings.ignorePaths.forEach((comparePath) => {
			if (comparePath === "") {
				// Ignore empty paths (occurs when the setting value is empty)
				return;
			}
			const regex = new RegExp(comparePath);
			if (path.match(regex)) {
				this.log(`Ignoring path: ${path}`);
				found = true;
			}
		});
		if (found) {
			return true;
		}
		return false;
	}

	/**
	 * Scan the changed folders and their ancestors for waypoints and update them if found.
	 */
	updateChangedFolders = async () => {
		this.log("Updating changed folders...");
		this.foldersWithChanges.forEach((folder) => {
			this.log("Updating " + folder.path);
			this.updateParentPoint(folder, true);
		});
		this.foldersWithChanges.clear();
	};

	/**
	 * Schedule an update for the changed folders after debouncing to prevent excessive updates.
	 */
	scheduleUpdate = debounce(this.updateChangedFolders.bind(this), 500, true);

	/**
	 * Update the ancestor waypoint (if any) of the given file/folder.
	 * @param node The node to start the search from
	 * @param includeCurrentNode Whether to include the given folder in the search
	 */
	updateParentPoint = async (node: TAbstractFile, includeCurrentNode: boolean) => {
		const [parentFlag, parentPoint] = await this.locateParentPoint(node, includeCurrentNode);
		if (parentPoint === null) {
			return;
		}
		this.updateWaypoint(parentPoint, parentFlag);
		this.updateParentPoint(parentPoint.parent, false);
	};

	/**
	 * Locate the ancestor waypoint (if any) of the given file/folder.
	 * @param node The node to start the search from
	 * @param includeCurrentNode Whether to include the given folder in the search
	 * @returns The ancestor waypoint, or null if none was found
	 */
	async locateParentPoint(node: TAbstractFile, includeCurrentNode: boolean): Promise<[WaypointType, TFile]> {
		this.log("Locating parent flag and file of " + node.name);
		let folder = includeCurrentNode ? node : node.parent;
		while (folder) {
			let folderNote;
			if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
				folderNote = this.app.vault.getAbstractFileByPath(folder.path + "/" + folder.name + ".md");
			} else {
				if (folder.parent) {
					folderNote = this.app.vault.getAbstractFileByPath(this.getCleanParentPath(folder) + folder.name + ".md");
				}
			}
			if (folderNote instanceof TFile) {
				this.log("Found folder note: " + folderNote.path);
				const text = await this.app.vault.cachedRead(folderNote);
				if (text.includes(Waypoint.BEGIN_WAYPOINT) || text.includes(this.settings.waypointFlag)) {
					this.log("Found parent waypoint!");
					return [WaypointType.Waypoint, folderNote];
				}
				if (text.includes(Waypoint.BEGIN_LANDMARK) || text.includes(this.settings.landmarkFlag)) {
					this.log("Found parent landmark!");
					return [WaypointType.Landmark, folderNote];
				}
			}
			folder = folder.parent;
		}
		this.log("No parent flag found.");
		return [null, null];
	}

	/**
	 * Get the parent folder of the given filepath if it exists.
	 * @param path The filepath to search
	 * @returns The parent folder, or null if none exists
	 */
	getParentFolder(path: string): TFolder {
		const abstractFile = this.app.vault.getAbstractFileByPath(path.split("/").slice(0, -1).join("/"));
		if (abstractFile instanceof TFolder) {
			return abstractFile;
		}
		return null;
	}

	log(message: string) {
		if (this.settings.debugLogging) {
			console.log(message);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class WaypointSettingsTab extends PluginSettingTab {
	plugin: Waypoint;

	constructor(app: App, plugin: Waypoint) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Waypoint Settings" });
		new Setting(this.containerEl)
			.setName("Folder Note Style")
			.setDesc("Select the style of folder global used.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption(FolderNoteType.InsideFolder, "Folder Name Inside")
					// .addOption(FolderNoteType.OutsideFolder, "Folder Name Outside")
					.setValue(this.plugin.settings.folderNoteType)
					.onChange(async (value) => {
						this.plugin.settings.folderNoteType = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Folder Note Name")
			.setDesc("If you use custom folder note name. Write that name.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.folderNoteName)
					.onChange(async (value) => {
						this.plugin.settings.folderNoteName = value;
						await this.plugin.saveSettings();
					})
			);
		// new Setting(containerEl)
		// 	.setName("Debug Plugin")
		// 	.setDesc("If enabled, the plugin will create extensive logs.")
		// 	.addToggle((toggle) =>
		// 		toggle
		// 			.setValue(this.plugin.settings.debugLogging)
		// 			.onChange(async (value) => {
		// 				this.plugin.settings.debugLogging = value;
		// 				await this.plugin.saveSettings();
		// 			})
		// 	);
		new Setting(containerEl)
			.setName("Show Folder Notes")
			.setDesc("If enabled, folder notes will be listed alongside other notes in the generated waypoints.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showFolderNotes).onChange(async (value) => {
					this.plugin.settings.showFolderNotes = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Show Non-Markdown Files")
			.setDesc("If enabled, non-Markdown files will be listed alongside other notes in the generated waypoints.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showNonMarkdownFiles).onChange(async (value) => {
					this.plugin.settings.showNonMarkdownFiles = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Show Enclosing Note")
			.setDesc("If enabled, the name of the folder note containing the waypoint will be listed at the top of the generated waypoints.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showEnclosingNote).onChange(async (value) => {
					this.plugin.settings.showEnclosingNote = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Stop Scan at Folder Notes")
			.setDesc("If enabled, the waypoint generator will stop scanning nested folders when it encounters a folder note. Otherwise, it will only stop if the folder note contains a waypoint.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.stopScanAtFolderNotes).onChange(async (value) => {
					this.plugin.settings.stopScanAtFolderNotes = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Use WikiLinks")
			.setDesc("If enabled, links will be generated like [[My Page]] instead of [My Page](../Folder/My%Page.md).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useWikiLinks).onChange(async (value) => {
					this.plugin.settings.useWikiLinks = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Use Title Property")
			.setDesc("If enabled, links will use the \"title\" frontmatter property for the displayed text (if it exists).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useFrontMatterTitle).onChange(async (value) => {
					this.plugin.settings.useFrontMatterTitle = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Use Spaces for Indentation")
			.setDesc("If enabled, the waypoint list will be indented with spaces rather than with tabs.")
			.addToggle((toggle: ToggleComponent) =>
				toggle.setValue(this.plugin.settings.useSpaces).onChange(async (value: boolean) => {
					this.plugin.settings.useSpaces = value;
					await this.plugin.saveSettings();
				})
			);
		// TODO: Determine if there is a number component that can be used here instead
		new Setting(containerEl)
			.setName("Number of Spaces for Indentation")
			.setDesc("If spaces are used for indentation, this is the number of spaces that will be used per indentation level.")
			.addText((text: TextComponent) =>
				text
					.setPlaceholder("2")
					.setValue("" + this.plugin.settings.numSpaces)
					.onChange(async (value: string) => {
						const num = parseInt(value, 10);
						if (isNaN(num)) return;
						this.plugin.settings.numSpaces = num;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Waypoint Flag")
			.setDesc("Text flag that triggers waypoint generation in a folder note. Must be surrounded by double-percent signs.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.waypointFlag)
					.setValue(this.plugin.settings.waypointFlag)
					.onChange(async (value) => {
						if (value && value.startsWith("%%") && value.endsWith("%%") && value !== "%%" && value !== "%%%" && value !== "%%%%") {
							this.plugin.settings.waypointFlag = value;
						} else {
							this.plugin.settings.waypointFlag = DEFAULT_SETTINGS.waypointFlag;
							console.error("Error: Waypoint flag must be surrounded by double-percent signs.");
						}
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Landmark Flag")
			.setDesc("Text flag that triggers landmark generation in a folder note. Must be surrounded by double-percent signs.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.landmarkFlag)
					.setValue(this.plugin.settings.landmarkFlag)
					.onChange(async (value) => {
						if (value && value.startsWith("%%") && value.endsWith("%%") && value !== "%%" && value !== "%%%" && value !== "%%%%") {
							this.plugin.settings.landmarkFlag = value;
						} else {
							this.plugin.settings.landmarkFlag = DEFAULT_SETTINGS.landmarkFlag;
							console.error("Error: Landmark flag must be surrounded by double-percent signs.");
						}
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Ignored Files/Folders")
			.setDesc("Regex list of files or folders to ignore while making indices. Enter only one regex per line.")
			.addTextArea((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.ignorePaths.join("\n"))
					.setValue(this.plugin.settings.ignorePaths.join("\n"))
					.onChange(async (value) => {
						const paths = value
							.trim()
							.split("\n")
							.map((value) => this.getNormalizedPath(value));
						this.plugin.settings.ignorePaths = paths;
						await this.plugin.saveSettings();
					})
			);
		const postscriptElement = containerEl.createEl("div", {
			cls: "setting-item"
		});
		const descriptionElement = postscriptElement.createDiv({
			cls: "setting-item-description"
		});
		descriptionElement.createSpan({
			text: "For instructions on how to use this plugin, check out the README on "
		});
		descriptionElement.createEl("a", {
			attr: { href: "https://github.com/IdreesInc/Waypoint" },
			text: "GitHub"
		});
		descriptionElement.createSpan({
			text: " or get in touch with the author "
		});
		descriptionElement.createEl("a", {
			attr: { href: "https://github.com/IdreesInc" },
			text: "@IdreesInc"
		});
		postscriptElement.appendChild(descriptionElement);
	}

	getNormalizedPath(path: string): string {
		return path.length == 0 ? path : normalizePath(path);
	}
}
