<script setup>
import { ref, computed, onMounted } from "vue";
import { storeToRefs } from "pinia";

import { useSurveyStore } from "@/stores/surveyStore";
import { useStationStore } from "@/stores/stationStore";
import { useSyncStore } from "@/stores/syncStore";
import { useImageStore } from "@/stores/imageStore";
import { useSnackbarStore } from "@/stores/snackbarStore";
import { useAuthStore } from "@/stores/authStore";
import { IndexedDBService } from "@/services/indexDB.js";
import { useRouter } from "vue-router";
import UploadImage from "../components/UploadImage.vue";
import Stats from "@/components/form/Stats.vue";
import StairForm from "@/components/form/StairForm.vue";
import AvatarStation from "@/components/select_station/AvatarStation.vue";

// Stores
const surveyStore = useSurveyStore();
const stationStore = useStationStore();
const syncStore = useSyncStore();
const imageStore = useImageStore();
const snackbarStore = useSnackbarStore();
const authStore = useAuthStore();
const router = useRouter();

const loading_station = ref(false);

// const emit = defineEmits(["save-complete", "back"]);
const emit = defineEmits(["save-complete"]);

// Actualizar estadísticas de sincronización al montar
onMounted(async () => {

  // Si no hay relevamiento activo (ej: recarga directa en /station/:id),
  // reconstruir el estado a partir del id de la URL.
  if (!surveyStore.isActive) {
    console.log("No hay relevamiento activo, reconstruyendo estado desde URL");
    // Asegurar que el catálogo esté cargado (rawStairs / fullStations)
    if (stationStore.fullStations.length === 0) {
      await stationStore.init();
    }

    const stationId = Number(router.currentRoute.value.params.station_id);
    const station = stationStore.fullStations.find((s) => s.id === stationId);

    if (!station) {
      snackbarStore.showError("No se encontró la estación");
      router.push({ name: "Home" });
      return;
    }

    stationStore.selectStation(station);
    surveyStore.startSurvey(station);
  }

    // Validar autenticación
  if (!authStore.isAuthenticated) {
    snackbarStore.showError("Debes autenticarte para realizar relevamientos");
    router.push({ name: "Home" });
    return;
  }
  
  await syncStore.updateSyncStats();
});

const { currentStairs, remainingStairs } = storeToRefs(surveyStore);
const { selectedStation } = storeToRefs(stationStore);

// Estado local
const expandedPanels = ref([]);

// Escalera elegida en el dropdown de "agregar reporte"
const stairToAdd = ref(null);

// Opciones del dropdown: descripción única (o "Escalera N" si no tuviera)
const remainingStairOptions = computed(() =>
  remainingStairs.value.map((s) => ({
    id: s.id,
    title: s.description || `Escalera ${s.number}`,
  }))
);

// Descripción de la escalera elegida, para leerla completa antes de "Agregar"
const selectedStairLabel = computed(() => {
  const opt = remainingStairOptions.value.find((o) => o.id === stairToAdd.value);
  return opt ? opt.title : "";
});

const all_status = [
  { label: "Pendiente", icon: "circle", color: "grey", key: "pending" },
  { label: "Funciona", icon: "check_circle", color: "green", is_working: true },
  { label: "No funciona", icon: "cancel", color: "red" },
];

// Marcar escalera como completada
const markStairComplete = (stairIndex) => {
  // Cerrar panel actual y abrir siguiente (si existe)
  const currentIndex = expandedPanels.value.indexOf(stairIndex);
  if (currentIndex > -1) {
    expandedPanels.value.splice(currentIndex, 1);
  }

  // if (stairIndex < surveyStore.total_stairs - 1) {
  //   expandedPanels.value.push(stairIndex + 1);
  // }
};

function showWarning(message) {
  snackbarStore.showWarning(message);
}

// Agregar un reporte para la escalera elegida en el dropdown
const handleAddReport = () => {
  if (!stairToAdd.value) return;
  const report = surveyStore.addReport(stairToAdd.value);
  stairToAdd.value = null;
  // Abrir el panel recién agregado (queda al final del arreglo)
  if (report) {
    expandedPanels.value.push(currentStairs.value.length - 1);
  }
};

// Quitar un reporte (y resetear los paneles abiertos para no dejar índices colgados)
const handleRemoveReport = (reportId) => {
  surveyStore.removeReport(reportId);
  expandedPanels.value = [];
};

// Guardar datos completos
const handleSave = async () => {
  try {
    // Validar que haya al menos un reporte completado
    const someCompleted = currentStairs.value.some(
      (s) => s.status === "completed"
    );

    if (!someCompleted) {
      snackbarStore.showWarning(
        "Debes completar al menos una escalera para guardar"
      );
      return;
    }
    loading_station.value = true;
    // 1. Guardar registro de estación en IndexedDB
    const savedRecord = await surveyStore.completeSurvey();

    // 2. Guardar imágenes de los reportes completados que NO estén ya en el backend
    for (let stairIndex = 0; stairIndex < currentStairs.value.length; stairIndex++) {
      const stair = currentStairs.value[stairIndex];
      if (stair.status !== "completed") continue;
      const photos = imageStore.getStairPhotos(stair.id); // ✅ Usar stair.id en lugar de índice

      // Guardar en IndexedDB si las imágenes NO están confirmadas en el backend
      // (reporte fallido, sin conexión, o subida de imágenes fallida) para reintentar.
      // Se usa stair.number como clave para que syncPendingStairs las encuentre.
      if (photos && photos.length > 0 && stair.images_synced !== true) {
        await IndexedDBService.saveStairImages(
          savedRecord.id,
          stair.number,
          photos
        );
        console.log(
          `📸 ${photos.length} imágenes guardadas localmente para escalera ${stair.number} (pendiente de sync)`
        );
      } else if (photos && photos.length > 0 && stair.images_synced === true) {
        console.log(
          `✅ Escalera ${stair.number} con imágenes ya sincronizadas - no guardadas en IndexedDB`
        );
      }
    }

    // 3. Limpiar el imageStore
    imageStore.clearSelection();

    // 4. Actualizar estadísticas de sincronización
    await syncStore.updateSyncStats();

    console.log("✅ Estación y todas las imágenes guardadas exitosamente");
    loading_station.value = false;
    snackbarStore.showSuccess("Relevamiento guardado exitosamente");
    router.push({ name: "Home" });
  } catch (error) {
    console.error("Error guardando:", error);
    snackbarStore.showError("Error al guardar los datos");
    loading_station.value = false;
  }
};

// Volver a selector
const handleBack = () => {
  if (
    confirm("¿Seguro que quieres salir? Se perderá el progreso no guardado")
  ) {
    surveyStore.cancelSurvey();
    router.push({ name: "Home" });
    // emit("back");
  }
};
</script>

<template>
  <v-row no-gutters class="fill-height">
    <v-col cols="12">
      <!-- Header con status -->
      <v-card class="rounded-0" variant="flat" color="grey-lighten-5">
        <v-card-text>
          <!-- Estación seleccionada -->
          <div class="d-flex align-center">
            <AvatarStation
              v-if="selectedStation"
              :station-data="selectedStation"
              class="mr-3"
            />
            <h2 class="text-subtitle-1 font-weight-bold">
              Estación {{ selectedStation?.name }}
            </h2>
            <v-btn
              icon="close"
              size="small"
              variant="text"
              @click="handleBack"
              class="ml-auto"
            ></v-btn>
          </div>
        </v-card-text>
      </v-card>

      <Stats :surveyStore="surveyStore" class="mb-2" />

      <v-divider></v-divider>
      <v-alert type="info" density="compact" class="mb-2">
        Reporta al menos una escalera. Identifícala por su descripción.
      </v-alert>

      <!-- Expansion Panels de Escaleras -->
      <v-expansion-panels v-model="expandedPanels" multiple>
        <StairForm
          v-for="(stair, stair_index) in currentStairs"
          :key="stair.id"
          :stair="stair"
          :stair_index="stair_index"
          :all_status="all_status"
          @showWarning="showWarning"
          @markComplete="markStairComplete(stair_index)"
          @remove="handleRemoveReport(stair.id)"
        />
      </v-expansion-panels>

      <!-- Agregar reporte de otra escalera -->
      <v-card
        v-if="remainingStairOptions.length > 0"
        class="rounded-lg my-2"
        variant="tonal"
        color="primary"
      >
        <v-card-text>
          <label class="text-subtitle-2 mb-2 d-block">
            ¿Qué escalera vas a reportar?
          </label>
          <div class="d-flex gap-2 align-center">
            <v-select
              v-model="stairToAdd"
              :items="remainingStairOptions"
              item-title="title"
              item-value="id"
              variant="outlined"
              color="primary"
              base-color="primary"
              bg-color="surface"
              placeholder="Selecciona una escalera por su descripción"
              hide-details
            ></v-select>
            <v-btn
              color="primary"
              :disabled="!stairToAdd"
              @click="handleAddReport"
              prepend-icon="add"
              class="ml-2"
            >
              Agregar
            </v-btn>
          </div>

          <!-- Descripción seleccionada, visible/legible antes de agregar -->
          <v-alert
            v-if="selectedStairLabel"
            class="mt-3"
            color="primary"
            variant="tonal"
            density="compact"
            icon="stairs"
          >
            {{ selectedStairLabel }}
          </v-alert>
        </v-card-text>
      </v-card>

      <!-- Botón guardar todo -->
      <v-card v-if="true" class="rounded-0" _variant="flat" _color="primary">
        <v-card-actions class="pa-4">
          <v-btn
            color="primary"
            size="large"
            block
            variant="elevated"
            :loading="loading_station"
            :disabled="surveyStore.completedStairs < 1"
            @click="handleSave"
          >
            Guardar reportes
            <v-icon end>save</v-icon>
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-col>
  </v-row>
</template>

<style scoped>
.gap-2 {
  gap: 8px;
}

label {
  font-weight: 500;
}
</style>
