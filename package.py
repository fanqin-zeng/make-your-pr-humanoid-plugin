"""Build the Qoder and VS Code VSIX release artifacts."""

import json
from pathlib import Path
from shutil import copyfile
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
NAMESPACE = "http://schemas.microsoft.com/developer/vsx-schema/2011"
ET.register_namespace("", NAMESPACE)


def element(parent, tag, attributes=None, text=None):
    item = ET.SubElement(parent, f"{{{NAMESPACE}}}{tag}", attributes or {})
    item.text = text
    return item


def manifest():
    doc = ET.Element(f"{{{NAMESPACE}}}PackageManifest", {"Version": "2.0.0"})
    metadata = element(doc, "Metadata")
    element(metadata, "Identity", {
        "Id": PACKAGE["name"], "Version": PACKAGE["version"], "Language": "zh-CN", "Publisher": PACKAGE["publisher"],
    })
    element(metadata, "DisplayName", text=PACKAGE["displayName"])
    element(metadata, "Description", text=PACKAGE["description"])
    element(metadata, "Categories", text=",".join(PACKAGE["categories"]))
    properties = element(metadata, "Properties")
    element(properties, "Property", {"Id": "Microsoft.VisualStudio.Code.Engine", "Value": PACKAGE["engines"]["vscode"]})
    installation = element(doc, "Installation")
    element(installation, "InstallationTarget", {"Id": "Microsoft.VisualStudio.Code"})
    element(doc, "Dependencies")
    assets = element(doc, "Assets")
    element(assets, "Asset", {"Type": "Microsoft.VisualStudio.Code.Manifest", "Path": "extension/package.json", "Addressable": "true"})
    element(assets, "Asset", {"Type": "Microsoft.VisualStudio.Services.Content.Details", "Path": "extension/README.md", "Addressable": "true"})
    return ET.tostring(doc, encoding="utf-8", xml_declaration=True)


def content_types(files):
    namespace = "http://schemas.openxmlformats.org/package/2006/content-types"
    types = ET.Element("Types", xmlns=namespace)
    mapping = {"json": "application/json", "js": "text/javascript", "css": "text/css", "html": "text/html",
               "md": "text/markdown", "svg": "image/svg+xml", "vsixmanifest": "text/xml"}
    for suffix in sorted({file.suffix.lstrip(".") for file in files} | {"vsixmanifest"}):
        ET.SubElement(types, "Default", Extension=suffix, ContentType=mapping[suffix])
    return ET.tostring(types, encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    files = [ROOT / "package.json", ROOT / "README.md", *sorted((ROOT / "src").glob("*.js")),
             *sorted(file for file in (ROOT / "media").iterdir() if file.is_file())]
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    basename = f"make-your-pr-humanoid-v{PACKAGE['version']}"
    vscode = dist / f"{basename}-vscode.vsix"
    qoder = dist / f"{basename}-qoder.vsix"
    with ZipFile(vscode, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types(files))
        archive.writestr("extension.vsixmanifest", manifest())
        for file in files:
            archive.write(file, (Path("extension") / file.relative_to(ROOT)).as_posix())
    copyfile(vscode, qoder)
    print(qoder)
    print(vscode)
