import os
import base64
import json

def create_auto_download_html():
    # 1. Ask for either a file path or a folder path
    input_path = input("Enter the full path of a file OR folder to embed: ").strip().strip('"')

    if os.path.isfile(input_path):
        file_paths = [input_path]
        output_html = "auto_download.html"
    elif os.path.isdir(input_path):
        recursive = input("Scan subfolders too? (y/n): ").strip().lower() in {"y", "yes"}
        file_paths = _collect_files(input_path, recursive=recursive)
        output_html = "auto_download_all.html"
        if not file_paths:
            print("Error: Folder has no files to embed.")
            return
    else:
        print("Error: Path is neither a valid file nor folder.")
        return

    print(f"Found {len(file_paths)} file(s). Reading and encoding...")

    # 2. Read files in binary mode and convert to Base64 payload list
    payloads = []
    for file_path in file_paths:
        file_name = os.path.basename(file_path)
        try:
            with open(file_path, "rb") as file:
                file_data = file.read()
                base64_string = base64.b64encode(file_data).decode("utf-8")
                payloads.append({
                    "name": file_name,
                    "data": base64_string,
                })
            print(f"  Encoded: {file_name}")
        except Exception as e:
            print(f"  Skipped '{file_name}' due to read error: {e}")

    if not payloads:
        print("Error: Could not read any files.")
        return

    safe_title = payloads[0]["name"] if len(payloads) == 1 else f"{len(payloads)} files"
    payloads_json = json.dumps(payloads)

    # 3. Create HTML with embedded JavaScript for sequential auto-download
    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Downloading {safe_title}...</title>
    <style>
        body {{ font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background-color: #f4f4f9; margin: 0; padding: 1rem; }}
        .card {{ background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 720px; width: 100%; }}
        .meta {{ color: #444; margin-top: .5rem; }}
        button {{ margin-top: 1rem; padding: .6rem 1rem; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; cursor: pointer; }}
        ul {{ text-align: left; max-height: 240px; overflow: auto; border: 1px solid #ddd; padding: .75rem 1rem; border-radius: 6px; }}
    </style>
</head>
<body>
    <div class="card">
        <h2>Your download should start automatically.</h2>
        <p class="meta" id="status">Preparing downloads...</p>
        <button id="retry" style="display:none;">Retry Downloads</button>
        <h3>Files</h3>
        <ul id="file-list"></ul>
    </div>

    <script>
        const files = {payloads_json};
        const listEl = document.getElementById("file-list");
        const statusEl = document.getElementById("status");
        const retryBtn = document.getElementById("retry");

        files.forEach((f) => {{
            const li = document.createElement("li");
            li.textContent = f.name;
            listEl.appendChild(li);
        }});

        function triggerDownload(file) {{
            const dataUri = "data:application/octet-stream;base64," + file.data;
            const link = document.createElement("a");
            link.href = dataUri;
            link.download = file.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }}

        function startDownloads() {{
            statusEl.textContent = `Starting download for ${{files.length}} file(s)...`;
            let i = 0;

            function next() {{
                if (i >= files.length) {{
                    statusEl.textContent = "All download triggers were fired. If some files were blocked, click Retry Downloads.";
                    retryBtn.style.display = "inline-block";
                    return;
                }}
                const f = files[i];
                statusEl.textContent = `Downloading (${{i + 1}}/${{files.length}}): ${{f.name}}`;
                triggerDownload(f);
                i += 1;
                setTimeout(next, 350);
            }}

            next();
        }}

        retryBtn.addEventListener("click", startDownloads);
        window.addEventListener("load", startDownloads);
    </script>
</body>
</html>"""

    # 4. Save the HTML content to a new file
    try:
        with open(output_html, "w", encoding="utf-8") as html_file:
            html_file.write(html_content)
        print(f"\nSuccess! The file '{output_html}' has been generated.")
        print(f"Embedded {len(payloads)} file(s).")
        print(f"Open '{output_html}' in your browser and test the auto-download.")
    except Exception as e:
        print(f"Error writing HTML file: {e}")


def _collect_files(folder_path: str, recursive: bool = False) -> list[str]:
    collected = []
    if recursive:
        for root, _, files in os.walk(folder_path):
            for name in files:
                collected.append(os.path.join(root, name))
    else:
        for name in os.listdir(folder_path):
            full_path = os.path.join(folder_path, name)
            if os.path.isfile(full_path):
                collected.append(full_path)
    return sorted(collected)

if __name__ == "__main__":
    create_auto_download_html()