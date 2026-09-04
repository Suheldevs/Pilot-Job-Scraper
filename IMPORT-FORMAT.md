# Import file formats

The **Import** button in the dashboard accepts **CSV** or **JSON**.
Download [sample-import.csv](sample-import.csv) for a working example.

Nothing is ever overwritten by an import — existing companies are left as they
are, and only new ones get added. Progress (stage/notes) merges newest-wins.

## CSV

One company per row. Only `name` and `tab` are required.

| Column | Required | Values / notes |
|---|---|---|
| `name` | **yes** | Company name. Also its identity — re-importing the same name in the same city does nothing. |
| `tab` | **yes** | `blr` · `pune` · `lko` · `noida` · `rem` |
| `section` | no | Contact-quality tier within the city. Auto-assigned if blank (HR email → tier 1, WhatsApp/live opening → tier 2, else last tier). `blr`: `s1,s2,s3` · `pune`: `p1,p2,p3` · `lko`: `l1,l2,l3` · `noida`: `n1,n2` · `rem`: `r1` |
| `hr` | no | HR inbox email(s). **Multiple values separated by `;`** (not commas — commas are the CSV delimiter). |
| `em` | no | General email(s), `;`-separated. |
| `wa` | no | WhatsApp number(s), `;`-separated, digits only with country code, e.g. `919611738802`. |
| `li` | no | LinkedIn company handle (e.g. `zethic-tech`) or a full URL. |
| `land` | no | Landline, free text. |
| `note` | no | Why they're worth contacting. Wrap in `"` if it contains a comma. |
| `job_url` | no | Link to a live opening. |
| `job_title` | no | Title of that opening. |
| `stage` | no | `none` (default) · `contacted` · `replied` · `interviewing` · `offer` · `rejected` |

Example:

```csv
name,tab,section,hr,em,wa,li,land,note,job_url,job_title,stage
Zethic Technologies,blr,s1,careers@zethic.com,hello@zethic.com,919611738802;919036910024,zethic-tech,,"Small team, founded 2019.",,,none
```

## JSON

Two shapes are accepted.

**Current export shape** (what the Export button produces — use this for backups):

```json
{
  "companies": [
    {
      "tab": "blr",
      "section": "s1",
      "n": "Zethic Technologies",
      "hr": ["careers@zethic.com"],
      "em": ["hello@zethic.com"],
      "wa": ["919611738802"],
      "li": "zethic-tech",
      "note": "Small team, founded 2019.",
      "job": { "u": "https://...", "t": "Full Stack Developer" },
      "stage": "contacted",
      "stage_note": "Emailed, no reply yet."
    }
  ],
  "template": "Hello, I am {name} …"
}
```

**Legacy hey.html shape** (the old localStorage export) is also accepted, so
old backups still load:

```json
{
  "state":  { "zethic-technologies": { "stage": "contacted", "at": 1788500000000, "note": "" } },
  "custom": { "s1": [ { "n": "Zethic Technologies", "hr": ["careers@zethic.com"] } ] },
  "tpl": "Hello, I am {name} …"
}
```

Note `custom` there is keyed by **section** (`s1`, `p2`, `r1`…), not by city.

## Pushing straight from the scraper

The scraper skips files entirely and posts to the API:

```
python push.py --url https://<your-site>.pages.dev --password '<passphrase>'
```

See [README.md](README.md).
