# Moving from SAFe Ado to ScaleLane

SAFe Ado has been renamed **ScaleLane**. The rename comes with a new Marketplace listing
(publisher `ScaleLane`, extension id `scalelane`), so Azure DevOps treats ScaleLane as a
different extension. Two things follow from that:

- **Your work items are not affected.** Epics, features, stories, iterations, area paths and links
  are ordinary Azure DevOps data and stay exactly as they are.
- **ScaleLane's own data does not move by itself.** The hierarchy and settings, PI objectives,
  ROAM risks, milestones, capacity, planning metadata, votes, reviews and improvement items live
  in the Extension Data Service, which is kept per extension. You move them with Export / Import.

Both extensions can be installed side by side while you migrate.

## Steps (per project)

1. **Export from SAFe Ado.** Open *Boards → SAFe → Setup → Backup & restore* and click
   **Export SAFe data**. Export is in SAFe Ado 1.3.0 and later; update SAFe Ado first if the
   section is missing.
   Keep the downloaded `safe-ado-backup-<project>-<date>.json` file.
2. **Install ScaleLane** from the Marketplace (Services) or upload the VSIX
   (*Collection settings → Extensions*, Server 2022.1).
3. **Import into ScaleLane.** Open *Boards → ScaleLane → Setup → Backup & restore*, choose the
   file, check the summary and pick **Overwrite** (the project is empty in ScaleLane). Include the
   configuration. ScaleLane reads SAFe Ado backup files unchanged.
4. **Check** the hierarchy, a PI's objectives and risks, and the Team Planning Board capacity.
   The import is recorded in *Setup → Audit log*.
5. Repeat for each project that uses SAFe Ado.
6. **Uninstall SAFe Ado** once every project is checked. Uninstalling deletes SAFe Ado's extension
   data, so keep the backup files.

Personal preferences (starred units, last view, board layout) are kept per extension in the browser
and start fresh in ScaleLane.

## For the publisher

- SAFe Ado 1.3.0 (published 2026-09-30, commit `8f142e1`, tag `v1.3.0`) is the release with Export,
  so existing users can already migrate.
- Once ScaleLane is live, publish SAFe Ado 1.3.1 from branch `safe-ado-final` with only the
  Marketplace description changed, pointing to ScaleLane and this guide.
- Set the old listing to private once existing customers have moved.
- Tags and release notes up to v1.3.0 refer to SAFe Ado; ScaleLane starts at 2.0.0.
