# Rencana: Config Wizard Loop

## Masalah
- `/crew-of-pi config` linear: pilih agent → edit 1 field → selesai → close
- User harus ulang dari /crew-of-pi config lagi untuk edit field lain
- Gak ada opsi simpan di project level (.pi/)

## Solusi

### 1. Loop — edit multiple fields & agents dalam 1 sesi

```
/crew-of-pi config
  → pick agent
  → pick field (model/extensions/skills)
  → edit + auto-save
  → "Edit field lain?" [model/extensions/skills/selesai]
    → pilih field lain → loop
    → "selesai" → "Config agent lain?" [ya/tidak]
      → ya → pick agent lagi
      → tidak → exit → pilih save location
```

### 2. Save location — global atau project

Di exit, user pilih:
- "Global (~/.pi/agent/)" — semua user
- "Project (.pi/)" — per project  
- "Both" — dua-duanya

### File kena

1. `config.helpers.ts` — tambah `getProjectConfigPath(cwd)`, `writeConfig` terima path opsional
2. `config.command.ts` — wrap flow dalam loop, tambah save location picker

### Estimasi
~30 baris baru, 2 file, 0 file baru
