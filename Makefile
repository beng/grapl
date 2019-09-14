SERVICE_DIRS ?= analyzer-dispatcher

build-artifact:
	$(foreach makefile, $(SERVICE_DIRS), \
		$(MAKE) -C $(makefile) build-artifact;)

fetch-artifact:
	$(foreach makefile, $(SERVICE_DIRS), \
		$(MAKE) -C $(makefile) fetch-artifact;)

run:
	$(foreach makefile, $(SERVICE_DIRS), \
		$(MAKE) -C $(makefile) run;)
