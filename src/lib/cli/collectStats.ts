import { join } from "path";
import { Buffer } from "buffer";
import { readdirSync, readFileSync, statSync } from "fs";

import { Node, Project, ProjectOptions } from "ts-morph";
import { TransactionalFileSystem, TsConfigResolver } from "@ts-morph/common";

import { hasProp, isNotUndefined, isRegexp, objectEntries, objectValues } from "../guards";
import { SUPPORTED_FILE_TYPES } from "../supportedFileTypes";
import { isModuleResolutionWarning, setupModuleResolution } from "../resolveModule/resolveModule";
import { resolveDependencies } from "../resolveDependencies/resolveDependencies";
import { isTraceImport, setupFindUsages } from "../findUsages/findUsages";
import { getImportFile, getImportNode, Import } from "../resolveDependencies/identifyImports";
import { detectHomebrew } from "../detectHomebrew/detectHomebrew";
import { ResolvedStatsConfig, UsageStat } from "./sharedTypes";
import { componentUsageDistribution, usageDistributionAcrossFileTree } from "./util/stats";

const jsRe = /\.jsx?$/;
const yarnDirRe = /\/\.yarn\//;

const hasTSConfig = hasProp("tsconfigPath");
const hasJSConfig = hasProp("jsconfigPath");
export async function collectStats(config: ResolvedStatsConfig, tag: () => string, projectPath: string): Promise<UsageStat[]> {
    const tsconfigPath = join(config.subprojectPath, (hasTSConfig(config) && config.tsconfigPath) || "tsconfig.json");
    const jsconfigPath = join(config.subprojectPath, (hasJSConfig(config) && config.jsconfigPath) || "jsconfig.json");

    console.log(`${ tag() } Setting up ts-morph project`);
    const getTsconfigCompilerOptions = () => {
        // TSConfig is a .json file, but it's not a JSON — e.g. it allows comments and composes `extends` references.
        const tsconfigResolutionFs = new TransactionalFileSystem({
            fileSystem: new Project({}).getFileSystem(),
            skipLoadingLibFiles: true,
            libFolderPath: undefined,
        });

        return new TsConfigResolver(
            tsconfigResolutionFs,
            tsconfigResolutionFs.getStandardizedAbsolutePath(join(projectPath, tsconfigPath)),
            "utf8",
        ).getCompilerOptions();
    };

    const getJsconfigCompilerOptions = () => ({
        ...JSON.parse(readFile(projectPath, jsconfigPath)).compilerOptions ?? {},
        allowJs: true,
    });

    const isTsProject = isFile(projectPath, tsconfigPath);
    if (hasTSConfig(config) && config.tsconfigPath && !isTsProject) { throw new Error(`Can't find tsconfig in project at path: ${ tsconfigPath }`); }

    const hasJsconfig = isFile(projectPath, jsconfigPath);
    if (hasJSConfig(config) && config.jsconfigPath && !hasJsconfig) { throw new Error(`Can't find jsconfig in project at path: ${ jsconfigPath }`); }

    /* eslint-disable indent */
    const projectConfig: ProjectOptions =
          isTsProject ? { compilerOptions: getTsconfigCompilerOptions() }
        : hasJsconfig ? { compilerOptions: getJsconfigCompilerOptions() }
        : { compilerOptions: { allowJs: true } };
    /* eslint-enable indent */

    const project = new Project(projectConfig);

    console.log(`${ tag() } Populating ts-morph project`);
    const allowJs = isTsProject ? project.getCompilerOptions().allowJs ?? false : true;
    const projectFiles = listFiles(
        projectPath,
        config.subprojectPath,
        f => (allowJs || !jsRe.test(f))
            && !yarnDirRe.test(f)
            && !config.isIgnoredFile.test(f),
    );
    projectFiles
        .filter(f => SUPPORTED_FILE_TYPES.some(ext => f.endsWith(ext)))
        .forEach(f => {
            const filePath = join(projectPath, f);
            const source = project.addSourceFileAtPath(filePath);

            const fileDirectives = [
                ...source.getPathReferenceDirectives(),
                ...source.getTypeReferenceDirectives(),
                ...source.getLibReferenceDirectives(),
            ];

            if (fileDirectives.length > 0) {
                // Files might have triple-slash directives pointing to files outside of project source.
                // For example, pointing to `node_modules/@types`. This causes ts-morph to fail.
                fileDirectives
                    .map(directive => source.getChildAtPos(directive.getPos()))
                    .filter(isNotUndefined)
                    .filter(Node.isCommentNode)
                    .forEach(node => node.remove());

                // Re-add file to project
                project.createSourceFile(filePath, source.getText(), { overwrite: true });
            }
        });

    console.log(`${ tag() } Resolving dependencies`);
    const resolve = setupModuleResolution(project, join(projectPath, config.subprojectPath));
    const dependencies = resolveDependencies(project, resolve);

    const findUsages = setupFindUsages(dependencies);
    const importSource = (imp: Import) => {
        const containingFilePath = getImportFile(imp).getFilePath();
        const resolvedModule = resolve(imp.moduleSpecifier, containingFilePath);
        const resolvedSource = isModuleResolutionWarning(resolvedModule) || !resolvedModule ? imp.moduleSpecifier : resolvedModule.getFilePath().replace(projectPath, "");
        return { containingFilePath: containingFilePath.replace(projectPath, ""), resolvedSource };
    };

    console.log(`${ tag() } Finding target imports`);

    const isTargetModuleOrPathMap = isRegexp(config.isTargetModuleOrPath) ? { target: config.isTargetModuleOrPath } : config.isTargetModuleOrPath;

    const allTargetRe = objectValues(isTargetModuleOrPathMap);
    const isAnyTargetModuleOrPath = (s: string) => allTargetRe.some(regEx => regEx.test(s));

    const allTargetUsages = objectEntries(isTargetModuleOrPathMap).map(([targetName, isTargetModuleOrPath]) => {
        const targetImports = dependencies.filterImports(imp => {
            const { containingFilePath, resolvedSource } = importSource(imp);
            return !isTargetModuleOrPath.test(containingFilePath) // File where the import is detected is not among target import files,
                && isTargetModuleOrPath.test(resolvedSource)      // Resolved source file is a target import,
                && config.isTargetImport(imp);                    // And further custom checks pass OK
        });
        console.log(`${ tag() } ${ targetImports.length } target ${ targetName } imports`);

        const targetUsages = targetImports.map((imp): UsageStat[] => {
            const componentName = getImportNode(imp).print();
            return findUsages(getImportNode(imp)).usages
                .filter(use => config.isValidUsage({ source: targetName, ...use }))
                .map(usage => ({
                    component_name: componentName,
                    source: targetName,
                    imported_from: importSource(imp).resolvedSource,
                    target_node_file: usage.target.getSourceFile().getFilePath().replace(projectPath, ""),
                    usage_file: usage.use.getSourceFile().getFilePath().replace(projectPath, ""),
                }));
        }).flat();
        console.log(`${ tag() } Targets (${ targetName }):`);
        console.log(componentUsageDistribution(targetUsages).split("\n").map(line => `${ tag() } ${ line }`).join("\n"));
        console.log(usageDistributionAcrossFileTree(targetUsages).split("\n").map(line => `${ tag() } ${ line }`).join("\n"));

        return targetUsages;
    });


    const homebrew = project.getSourceFiles()
        .map(detectHomebrew)
        .reduce((a, b) => [...a, ...b], [])

        // Ignore homebrew files detected in the target file (happens if the target is a directory in the project)
        .filter(component => !isAnyTargetModuleOrPath(component.declaration.getSourceFile().getFilePath().replace(projectPath, "")));
    console.log(`${ tag() } ${ homebrew.length } homebrew components`);

    const homebrewUsages = homebrew.map((homebrewComponent): UsageStat[] => {
        const componentName = homebrewComponent.identifier ? homebrewComponent.identifier.print() : homebrewComponent.declaration.print().replace(/\n/g, " ");
        return findUsages(homebrewComponent.identifier ?? homebrewComponent.declaration).usages
            .filter(({ use }) => !isAnyTargetModuleOrPath(use.getSourceFile().getFilePath().replace(projectPath, ""))) // Ignore usages in target directory (in case target is a directory)
            .filter(use => config.isValidUsage({ source: "homebrew", ...use }))
            .map(usage => {
                const importTrace = usage.trace.reverse().find(isTraceImport);
                const targetNodeFile = usage.target.getSourceFile().getFilePath().replace(projectPath, "");

                return {
                    component_name: componentName,
                    source: "homebrew",
                    imported_from: importTrace ? importSource(importTrace.imp).resolvedSource : targetNodeFile,
                    target_node_file: targetNodeFile,
                    usage_file: usage.use.getSourceFile().getFilePath().replace(projectPath, ""),
                };
            });
    }).flat();
    console.log(`${ tag() } Homebrew:`);
    console.log(componentUsageDistribution(homebrewUsages).split("\n").map(line => `${ tag() } ${ line }`).join("\n"));
    console.log(usageDistributionAcrossFileTree(homebrewUsages).split("\n").map(line => `${ tag() } ${ line }`).join("\n"));


    return [...allTargetUsages.flat(), ...homebrewUsages];
}

function isFile(projectPath: string, path: string): boolean {
    return statSync(join(projectPath, path), { throwIfNoEntry: false })?.isFile() ?? false;
}

function readFile(projectPath: string, path: string): string {
    const data = readFileSync(join(projectPath, path));
    return Buffer.from(data).toString("utf8");
}

function listFiles(projectPath: string, path: string, filter: (f: string) => boolean): string[] {
    const files: string[] = [];
    const dir = readdirSync(join(projectPath, path));
    for (const p of dir) {
        const filepath = join(path, p);
        if (filepath === "/.git") { continue; } // Ignore git contents
        if (!filter(filepath)) { continue; } // Skip ignored files

        const stat = statSync(join(projectPath, filepath), { throwIfNoEntry: false });
        if (!stat) { continue; } // TODO: warn?
        if (stat.isFile()) { files.push(filepath); }
        if (stat.isDirectory()) { files.push(...listFiles(projectPath, filepath, filter)); }
    }
    return files;
}
