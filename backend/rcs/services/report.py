"""PDF reports. Every page states that results are modelled from assumed inputs."""
from __future__ import annotations

import io

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from ..sim.params import PARAM_PROVENANCE

NAVY = colors.HexColor("#0b1a2b")
RULE = colors.HexColor("#c9d3de")


def _footer(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor("#5a6a7a"))
    canvas.drawString(15 * mm, 9 * mm, "RCS COMMAND demonstration. MODELLED results from assumed inputs. Not measured data and not an operational finding.")
    canvas.drawRightString(doc.pagesize[0] - 15 * mm, 9 * mm, f"Page {doc.page}")
    canvas.restoreState()


def experiment_pdf(e, header: list[str], rows: list[list]) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm, bottomMargin=16 * mm, title=f"RCS experiment {e.id}")
    st = getSampleStyleSheet()
    cell = st["BodyText"].clone("cell", fontSize=7.2, leading=9)
    head = st["BodyText"].clone("head", fontSize=7.2, leading=9, textColor=colors.white, fontName="Helvetica-Bold")
    story = [Paragraph(f"RCS COMMAND: {e.name}", st["Title"].clone("t", alignment=0, fontSize=17, textColor=NAVY)), Paragraph(f"Experiment {e.id} ({e.kind}). Run by {e.created_by}. Status {e.status}.", st["BodyText"]), Spacer(1, 4 * mm)]
    r = e.result or {}
    if r.get("design"):
        d = r["design"]
        story.append(Paragraph("Design: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in d.items()), st["BodyText"]))
    if r.get("trace"):
        for line in r["trace"]:
            story.append(Paragraph(line, st["BodyText"]))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph("Results (modelled)", st["Heading3"]))
    max_cols = len(header)
    data = [[Paragraph(str(h).replace("_", " "), head) for h in header]] + [[Paragraph(str(c), cell) for c in row] for row in rows[:400]]
    table = Table(data, repeatRows=1, colWidths=[(doc.width / max_cols)] * max_cols)
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), NAVY), ("LINEBELOW", (0, 0), (-1, -1), 0.25, RULE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))
    story.append(table)
    story.append(Spacer(1, 5 * mm))
    story.append(Paragraph("Assumed inputs and where they come from", st["Heading3"]))
    cfg = e.config or {}
    prov = [[Paragraph("Input", head), Paragraph("Value", head), Paragraph("Status", head)]]
    for key, why in PARAM_PROVENANCE.items():
        if key in cfg:
            prov.append([Paragraph(key.replace("_", " "), cell), Paragraph(str(cfg[key]), cell), Paragraph(why, cell)])
    if len(prov) > 1:
        t2 = Table(prov, repeatRows=1, colWidths=[doc.width * 0.28, doc.width * 0.12, doc.width * 0.6])
        t2.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), NAVY), ("LINEBELOW", (0, 0), (-1, -1), 0.25, RULE), ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))
        story.append(t2)
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()
