SERVICE_DIRS ?= analyzer-dispatcher \
		generic-subgraph-generator \
		sysmon-subgraph-generator

build-artifact:
	$(foreach makefile, $(SERVICE_DIRS), \
		$(MAKE) -C $(makefile) build-artifact;)

fetch-artifact:
	$(foreach makefile, $(SERVICE_DIRS), \
		$(MAKE) -C $(makefile) fetch-artifact;)

run:
	$(foreach makefile, $(SERVICE_DIRS), \
		$(MAKE) -C $(makefile) run;)
