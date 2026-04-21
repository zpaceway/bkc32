.PHONY: server server-sim sim-board webapp install docs clean screenshots

server:
	uv run server.py

server-sim:
	SERIAL_PORT=/tmp/bkc32-sim-serial uv run server.py

sim-board:
	uv run src/sim_board.py --link /tmp/bkc32-sim-serial --profile alternating --point-delay 0.05

webapp:
	cd webapp && npm run dev

install:
	uv sync
	cd webapp && npm install

docs:
	@for phase in 1 2 3 4; do \
		echo "Building phase $$phase..."; \
		cp -n documents/template/estilo_unir-1.sty documents/deliveries/phase.$$phase/ 2>/dev/null || true; \
		cp -n documents/template/logo_unir.png documents/deliveries/phase.$$phase/ 2>/dev/null || true; \
	done
	-cd documents/deliveries/phase.1 && pdflatex -interaction=nonstopmode fase1_requerimientos.tex > /dev/null 2>&1 && pdflatex -interaction=nonstopmode fase1_requerimientos.tex > /dev/null 2>&1
	-cd documents/deliveries/phase.2 && pdflatex -interaction=nonstopmode fase2_comunicacion.tex > /dev/null 2>&1 && pdflatex -interaction=nonstopmode fase2_comunicacion.tex > /dev/null 2>&1
	-cd documents/deliveries/phase.3 && pdflatex -interaction=nonstopmode fase3_adquisicion_visualizacion.tex > /dev/null 2>&1 && pdflatex -interaction=nonstopmode fase3_adquisicion_visualizacion.tex > /dev/null 2>&1
	-cd documents/deliveries/phase.4 && pdflatex -interaction=nonstopmode fase4_registro_exportacion.tex > /dev/null 2>&1 && pdflatex -interaction=nonstopmode fase4_registro_exportacion.tex > /dev/null 2>&1
	@echo "PDFs built successfully."

screenshots:
	@echo "Starting simulated board, backend and webapp for screenshot capture..."
	@mkdir -p documents/deliveries/phase.3/img documents/deliveries/phase.4/img
	@rm -f /tmp/bkc32-screenshots.sim.pid /tmp/bkc32-screenshots.server.pid /tmp/bkc32-screenshots.web.pid /tmp/bkc32-sim-serial
	@( uv run src/sim_board.py --link /tmp/bkc32-sim-serial --profile alternating --point-delay 0.05 > /tmp/bkc32-screenshots.sim.log 2>&1 & echo $$! > /tmp/bkc32-screenshots.sim.pid )
	@sleep 1
	@( SERIAL_PORT=/tmp/bkc32-sim-serial uv run server.py > /tmp/bkc32-screenshots.server.log 2>&1 & echo $$! > /tmp/bkc32-screenshots.server.pid )
	@sleep 2
	@cd webapp && npm run build > /tmp/bkc32-screenshots.build.log 2>&1
	@( cd webapp && npx vite preview --host 127.0.0.1 --port 5173 --strictPort > /tmp/bkc32-screenshots.web.log 2>&1 & echo $$! > /tmp/bkc32-screenshots.web.pid )
	@echo "Waiting for webapp to be ready..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
		curl -sf http://127.0.0.1:5173 > /dev/null && break || sleep 1; \
	done
	@echo "Running Playwright capture..."
	@cd webapp && WEBAPP_URL=http://127.0.0.1:5173 node scripts/capture_screenshots.mjs; status=$$?; \
		cd .. ; \
		for f in /tmp/bkc32-screenshots.web.pid /tmp/bkc32-screenshots.server.pid /tmp/bkc32-screenshots.sim.pid; do \
			if [ -f $$f ]; then kill $$(cat $$f) 2>/dev/null || true; rm -f $$f; fi; \
		done; \
		rm -f /tmp/bkc32-sim-serial; \
		exit $$status

clean:
	find documents/deliveries -name '*.aux' -o -name '*.log' -o -name '*.out' -o -name '*.toc' -o -name '*.lof' -o -name '*.lot' -o -name '*.fls' -o -name '*.fdb_latexmk' -o -name '*.synctex.gz' | xargs rm -f
	@echo "Cleaned LaTeX artifacts."
