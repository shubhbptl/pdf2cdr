#!/usr/bin/env python3
"""Builds test/fixtures/harbour-lights.pdf: an A5 flyer exercising gradients, clips, CMYK, transparency,
curves, strokes and embedded-font text — the sample the website opens with."""
from reportlab.lib.colors import CMYKColor, Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(TTFont("DejaVuB", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
W, H = 420, 595  # A5
c = canvas.Canvas("test/fixtures/harbour-lights.pdf", pagesize=(W, H))
c.setTitle("Harbour Lights - sample flyer")

# Sky: linear gradient clipped to the upper area
c.saveState()
p = c.beginPath(); p.rect(0, 220, W, H - 220); c.clipPath(p, stroke=0, fill=0)
c.linearGradient(0, H, 0, 220, (Color(0.05, 0.12, 0.32), Color(0.95, 0.45, 0.35)), extend=True)
c.restoreState()

# Sun: radial gradient clipped to a circle
c.saveState()
p = c.beginPath(); p.circle(300, 300, 70); c.clipPath(p, stroke=0, fill=0)
c.radialGradient(300, 300, 70, (Color(1, 0.95, 0.6), Color(1, 0.55, 0.2)))
c.restoreState()

# Sea in CMYK with curved waves
c.setFillColor(CMYKColor(1, 0.45, 0, 0.35)); c.rect(0, 0, W, 250, fill=1, stroke=0)
c.setFillColor(CMYKColor(0.85, 0.3, 0, 0.2))
for i in range(6):
    y = 40 + i * 34
    p = c.beginPath(); p.moveTo(0, y)
    for k in range(8):
        x = k * 60
        p.curveTo(x + 15, y + 10, x + 45, y - 10, x + 60, y)
    p.lineTo(W, y - 14); p.lineTo(0, y - 14); p.close()
    c.drawPath(p, fill=1, stroke=0)

# Lighthouse
c.setFillColorRGB(0.96, 0.96, 0.94); c.setStrokeColorRGB(0.12, 0.12, 0.16); c.setLineWidth(2); c.setLineJoin(1)
p = c.beginPath(); p.moveTo(80, 230); p.lineTo(130, 230); p.lineTo(120, 420); p.lineTo(90, 420); p.close()
c.drawPath(p, fill=1, stroke=1)
c.setFillColorRGB(0.86, 0.12, 0.18)
for y0, y1 in ((270, 300), (340, 370)):
    t = lambda y: (y - 230) / 190
    xl = lambda y: 80 + 10 * t(y)
    xr = lambda y: 130 - 10 * t(y)
    p = c.beginPath(); p.moveTo(xl(y0), y0); p.lineTo(xr(y0), y0); p.lineTo(xr(y1), y1); p.lineTo(xl(y1), y1); p.close()
    c.drawPath(p, fill=1, stroke=0)
c.setFillColorRGB(0.12, 0.12, 0.16); c.rect(84, 420, 42, 10, fill=1, stroke=0)
c.setFillColorRGB(1, 0.85, 0.3); c.rect(92, 430, 26, 22, fill=1, stroke=1)
c.setFillColorRGB(0.12, 0.12, 0.16)
p = c.beginPath(); p.moveTo(86, 452); p.lineTo(124, 452); p.lineTo(105, 472); p.close(); c.drawPath(p, fill=1, stroke=0)

# Light beams with 35 % opacity
c.setFillAlpha(0.35); c.setFillColorRGB(1, 0.92, 0.55)
p = c.beginPath(); p.moveTo(118, 441); p.lineTo(W, 500); p.lineTo(W, 400); p.close(); c.drawPath(p, fill=1, stroke=0)
p = c.beginPath(); p.moveTo(92, 441); p.lineTo(0, 470); p.lineTo(0, 420); p.close(); c.drawPath(p, fill=1, stroke=0)
c.setFillAlpha(1)

# Text (embedded font, becomes curves)
c.setFillColorRGB(1, 1, 1); c.setFont("DejaVuB", 34); c.drawString(30, 540, "Harbour Lights")
c.setFont("DejaVu", 13); c.drawString(32, 516, "Night walk · Saturday 14 March · 7 pm")
c.setFont("DejaVuB", 11); c.drawString(30, 24, "Pier 3 · free entry · bring a torch")
c.save()
print("wrote test/fixtures/harbour-lights.pdf")
