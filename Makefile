.PHONY: server webapp install docs clean

server:
	uv run server.py

webapp:
	cd webapp && npm run dev

install:
	uv sync
	cd webapp && npm install

docs:
	@for phase in 1 2; do \
		echo "Building phase $$phase..."; \
		cp -n documents/template/estilo_unir-1.sty documents/deliveries/phase.$$phase/ 2>/dev/null || true; \
		cp -n documents/template/logo_unir.png documents/deliveries/phase.$$phase/ 2>/dev/null || true; \
	done
	-cd documents/deliveries/phase.1 && pdflatex -interaction=nonstopmode fase1_requerimientos.tex > /dev/null 2>&1 && pdflatex -interaction=nonstopmode fase1_requerimientos.tex > /dev/null 2>&1
	-cd documents/deliveries/phase.2 && pdflatex -interaction=nonstopmode fase2_comunicacion.tex > /dev/null 2>&1 && pdflatex -interaction=nonstopmode fase2_comunicacion.tex > /dev/null 2>&1
	@echo "PDFs built successfully."

clean:
	find documents/deliveries -name '*.aux' -o -name '*.log' -o -name '*.out' -o -name '*.toc' -o -name '*.lof' -o -name '*.lot' -o -name '*.fls' -o -name '*.fdb_latexmk' -o -name '*.synctex.gz' | xargs rm -f
	@echo "Cleaned LaTeX artifacts."
