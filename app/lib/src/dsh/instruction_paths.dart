/// Paths and names for the instruction files a phone may create.
///
/// DSH loads `AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md` and `CLAUDE.local.md`,
/// in that order within one directory: base candidates first, local overlays
/// after. The Host refuses every other name, so the phone only ever offers
/// these four — offering a name that would be rejected after someone typed a
/// whole file is worse than not offering it at all.
library;

/// The four names the loader reads, base candidates before local overlays.
const List<String> instructionFileNames = <String>[
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
];

/// One line on what a candidate name is for, so the list is not four identical rows.
String instructionCandidateHint(String name) {
  switch (name) {
    case 'AGENTS.md':
      return '通用的项目指令';
    case 'CLAUDE.md':
      return '同一批指令的别名，内容重复时只加载一次';
    case 'AGENTS.local.md':
      return '本地覆盖，通常不进版本库';
    case 'CLAUDE.local.md':
      return '本地覆盖的别名';
    default:
      return '';
  }
}

/// Joins a directory and a file name the way the Host will see the path.
///
/// The separator follows the directory's own style rather than the phone's
/// platform: these paths live on the computer, which may not be the OS the
/// phone runs. A directory that already ends in a separator does not get a
/// second one.
String instructionFilePath(String directory, String name) {
  if (directory.isEmpty) return name;
  final last = directory.substring(directory.length - 1);
  if (last == r'\' || last == '/') return '$directory$name';
  final separator = directory.contains(r'\') ? r'\' : '/';
  return '$directory$separator$name';
}

/// Where a brand-new instruction file would land.
///
/// The project root wins over the session directory: an `AGENTS.md` at the root
/// applies to every subdirectory, which is what someone adding the first one
/// almost always means. Without a project, the session directory is the only
/// scope the Host will accept. Null means there is nowhere legal to write.
String? instructionCreateDirectory({
  required String? projectRoot,
  required String? cwd,
}) {
  if (projectRoot != null && projectRoot.isNotEmpty) return projectRoot;
  if (cwd != null && cwd.isNotEmpty) return cwd;
  return null;
}
