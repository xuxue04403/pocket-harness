import 'package:material_ui/material_ui.dart';

import '../dsh/host_link.dart';

/// Picks a skill to insert into the composer as `/name`.
///
/// DSH exposes skills as slash commands, so the phone inserts the same text a
/// person would type on the desktop rather than inventing a second protocol. The
/// catalog is session-addressed, which is why this needs the session's list
/// rather than a global one: a session in another directory sees other skills.
class SkillSheet extends StatefulWidget {
  const SkillSheet({super.key, required this.skills});

  final Future<List<SkillEntry>> skills;

  @override
  State<SkillSheet> createState() => _SkillSheetState();
}

class _SkillSheetState extends State<SkillSheet> {
  final TextEditingController _filter = TextEditingController();

  @override
  void dispose() {
    _filter.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      // Lifts the sheet above the keyboard, which opens as soon as it is shown.
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.75),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('插入技能', style: theme.textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Text(
                    '技能清单由电脑按这个会话的目录和预设决定，插进去就是一条 /指令。',
                    style: theme.textTheme.bodySmall,
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _filter,
                    decoration: const InputDecoration(
                      hintText: '按名称或用途筛选',
                      prefixIcon: Icon(Icons.search),
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: FutureBuilder<List<SkillEntry>>(
                future: widget.skills,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const Center(child: CircularProgressIndicator());
                  }
                  if (snapshot.hasError) {
                    return Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text('读不到技能清单：${snapshot.error}', style: theme.textTheme.bodySmall),
                    );
                  }
                  final all = snapshot.data ?? const <SkillEntry>[];
                  final matches = filterSkills(all, _filter.text);
                  if (matches.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        all.isEmpty ? '这个会话没有可用技能。' : '没有匹配的技能。',
                        style: theme.textTheme.bodyMedium,
                      ),
                    );
                  }
                  return ListView.separated(
                    itemCount: matches.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final skill = matches[index];
                      return ListTile(
                        title: Text('/${skill.name}'),
                        subtitle: Text(
                          skill.description,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        // The model can also reach these on its own; saying so
                        // helps a person tell the two sets apart.
                        trailing: skill.modelInvocable ? null : const Icon(Icons.person_outline, size: 18),
                        onTap: () => Navigator.of(context).pop(skill),
                      );
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shows the skill sheet and returns the chosen skill, or null.
Future<SkillEntry?> showSkillSheet(BuildContext context, {required Future<List<SkillEntry>> skills}) {
  return showModalBottomSheet<SkillEntry>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => SkillSheet(skills: skills),
  );
}
